/**
 * copilot-bridge renderer-inject.js
 *
 * 注入到 Codex.app renderer 让模型菜单显示所有 Copilot 模型（Claude / Gemini / GPT 等）。
 *
 * 来源：CodexPlusPlus assets/inject/renderer-inject.js 4413-4944 行（模型 patch 块）
 * 精简策略：
 *   - 只保留 5 路径联合 patch（Response.json / app-server sendRequest / dispatchEvent / Statsig / React Fiber）
 *   - catalog 从 http://127.0.0.1:8787/v1/model-catalog 拉（不走 CDP binding）
 *   - 删除诊断日志上报、settings 菜单、image overlay、plugin marketplace 等所有非模型相关功能
 *   - codexPlusModelUnlockEnabled() 写死返回 true
 *
 * 工作原理 5 路径：
 *   1. Response.prototype.json — 拦截任何 HTTP /models 响应
 *   2. app-server-manager-signals chunk sendRequest — patch list-models-for-host 方法
 *   3. window.dispatchEvent / message — 拦截 MCP model/list 请求和响应
 *   4. Statsig dynamic config (id 107580212) — patch 模型白名单
 *   5. React Fiber — MutationObserver 触发，遍历 menu/listbox 节点 props 直改
 */

(() => {
  if (window.__COPILOT_BRIDGE_INSTALLED__) return
  window.__COPILOT_BRIDGE_INSTALLED__ = true
  // eslint-disable-next-line no-console
  console.log('[copilot-bridge] renderer-inject installed')

  // ============================================================
  // 配置：catalog 数据源
  // ============================================================
  // 注意：不能用 fetch http://127.0.0.1:8787 — Codex.app 的 CSP 拦截 app:// → http 跨域
  // 改用 CDP bridge 通道：renderer 调 window.__codexSessionDeleteBridge("/model-catalog", {})
  //                       → host (我们的 launch 命令) 调 listCopilotModels() → 回数据
  const CATALOG_CACHE_MS = 10_000
  const STATSIG_MODEL_CONFIG_ID = '107580212'
  const APP_SERVER_CHUNK = 'app-server-manager-signals-'
  const codexAppServerModelRequestPatchVersion = '1'

  // ============================================================
  // 状态
  // ============================================================
  let codexModelCatalog = {
    status: 'loading',
    model: '',
    default_model: '',
    model_provider: '',
    provider_name: '',
    models: [],
    sources: [],
    responses_api: { status: 'unknown', message: '' },
  }
  let codexModelCatalogLoadedAt = 0
  let codexModelCatalogPromise = null
  let codexModelWhitelistRefreshTimer = 0
  let codexModelWhitelistRefreshUntil = 0
  const codexPlusModelListRequestIds = new Set()
  const codexServiceTierModulePromises = new Map()

  // ============================================================
  // 工具函数
  // ============================================================

  /** 永远启用模型解锁（CodexPlusPlus 这里是 settings 开关） */
  function codexPlusModelUnlockEnabled() {
    return true
  }

  function uniqueValues(values) {
    return Array.from(new Set(values.filter((value) => typeof value === 'string' && value.trim().length > 0)))
  }

  /** 当前 catalog 里所有模型名（含 default_model / model + models 数组） */
  function codexPlusModelNames() {
    return uniqueValues([
      codexModelCatalog.default_model,
      codexModelCatalog.model,
      ...(Array.isArray(codexModelCatalog.models) ? codexModelCatalog.models : []),
    ])
  }

  /**
   * 加载 catalog（通过 CDP bridge，10s 缓存）
   * 改自 CodexPlusPlus loadCodexModelCatalog — 数据源用 bridge 而非 HTTP fetch
   * （Codex.app CSP 不允许 renderer fetch http://127.0.0.1:*）
   */
  async function loadCodexModelCatalog(force = false) {
    if (!force && codexModelCatalogPromise) return codexModelCatalogPromise
    if (!force && codexModelCatalogLoadedAt && Date.now() - codexModelCatalogLoadedAt < CATALOG_CACHE_MS) {
      return codexModelCatalog
    }

    const bridge = window.__codexSessionDeleteBridge
    if (typeof bridge !== 'function') {
      console.warn('[copilot-bridge] bridge not ready yet')
      return codexModelCatalog
    }

    codexModelCatalogPromise = bridge('/model-catalog', {})
      .then((result) => {
        codexModelCatalog =
          result && typeof result === 'object'
            ? result
            : {
                status: 'failed',
                model: '',
                default_model: '',
                model_provider: '',
                provider_name: '',
                models: [],
                sources: [],
                responses_api: { status: 'unknown', message: '' },
              }
        codexModelCatalogLoadedAt = Date.now()
        scheduleCodexModelWhitelistRefresh()
        return codexModelCatalog
      })
      .catch((error) => {
        codexModelCatalog = {
          status: 'failed',
          message: String(error?.message || error),
          model: '',
          default_model: '',
          model_provider: '',
          provider_name: '',
          models: [],
          sources: [],
          responses_api: { status: 'unknown', message: '' },
        }
        codexModelCatalogLoadedAt = Date.now()
        return codexModelCatalog
      })
      .finally(() => {
        codexModelCatalogPromise = null
      })
    return codexModelCatalogPromise
  }

  /** 给注入的 model 生成完整 descriptor 对象（按 Codex menu 期望 schema） */
  function modelReasoningEfforts() {
    return ['minimal', 'low', 'medium', 'high', 'xhigh'].map((reasoningEffort) => ({
      reasoningEffort,
      description: `${reasoningEffort} effort`,
    }))
  }

  function codexPlusModelDescriptor(modelName) {
    return {
      model: modelName,
      id: modelName,
      slug: modelName,
      name: modelName,
      displayName: modelName,
      description: codexModelCatalog.provider_name || codexModelCatalog.model_provider || 'Custom model',
      hidden: false,
      isDefault: (codexModelCatalog.default_model || codexModelCatalog.model) === modelName,
      defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: modelReasoningEfforts(),
    }
  }

  // ============================================================
  // Codex App 内部 webpack chunk 动态导入
  // ============================================================

  function codexAppAssetUrl(namePart) {
    const urls = [
      ...Array.from(document.scripts || []).map((script) => script.src),
      ...Array.from(document.querySelectorAll('link[href]') || []).map((link) => link.href),
      ...performance.getEntriesByType('resource').map((entry) => entry.name),
    ].filter(Boolean)
    return (
      urls.find((url) => url.includes('/assets/') && url.includes(namePart) && url.split('?')[0].endsWith('.js')) || ''
    )
  }

  async function loadCodexAppModule(namePart) {
    if (!codexServiceTierModulePromises.has(namePart)) {
      const promise = Promise.resolve()
        .then(async () => {
          const url = codexAppAssetUrl(namePart)
          if (!url) throw new Error(`未找到 Codex App asset: ${namePart}`)
          return await import(url)
        })
        .catch((error) => {
          codexServiceTierModulePromises.delete(namePart)
          throw error
        })
      codexServiceTierModulePromises.set(namePart, promise)
    }
    return await codexServiceTierModulePromises.get(namePart)
  }

  // ============================================================
  // 核心 patch 函数（model array / container / object graph）
  // ============================================================

  function modelArrayLooksPatchable(value, allowEmpty = false) {
    return (
      Array.isArray(value) &&
      (allowEmpty || value.length > 0) &&
      value.every((item) => item && typeof item === 'object' && typeof item.model === 'string')
    )
  }

  function stringArrayLooksPatchable(value) {
    return Array.isArray(value) && value.every((item) => typeof item === 'string')
  }

  /** 往字符串数组追加自定义模型名 */
  function patchModelNameArray(models) {
    if (!stringArrayLooksPatchable(models)) return false
    const customModels = codexPlusModelNames()
    if (!customModels.length) return false
    let changed = false
    customModels.forEach((modelName) => {
      if (!models.includes(modelName)) {
        models.push(modelName)
        changed = true
      }
    })
    return changed
  }

  /** 往对象数组追加自定义 model descriptor */
  function patchModelArray(models, allowEmpty = false) {
    if (!modelArrayLooksPatchable(models, allowEmpty)) return false
    const customModels = codexPlusModelNames()
    if (!customModels.length) return false
    let changed = false
    const existing = new Map(models.map((item) => [item.model, item]))
    models.forEach((item) => {
      if (customModels.includes(item.model) && item.hidden !== false) {
        item.hidden = false
        changed = true
      }
    })
    customModels.forEach((modelName) => {
      if (!existing.has(modelName)) {
        models.push(codexPlusModelDescriptor(modelName))
        changed = true
      }
    })
    return changed
  }

  /** 识别 7~8 种 model 容器形状并统一改写 */
  function patchModelContainer(value) {
    if (!value || typeof value !== 'object') return false
    let changed = false
    if (patchModelArray(value.models, 'defaultModel' in value || 'availableModels' in value)) changed = true
    if (patchModelNameArray(value.models)) changed = true
    if (patchModelArray(value.data)) changed = true
    if (patchModelArray(value.result)) changed = true
    if (patchModelArray(value.pages?.[0]?.data)) changed = true
    if (patchModelArray(value.result?.data)) changed = true
    if (patchModelArray(value.result?.models)) changed = true
    if (patchModelArray(value.message?.result?.data)) changed = true
    if (patchModelArray(value.message?.result?.models)) changed = true

    const names = codexPlusModelNames()
    if (value.availableModels instanceof Set) {
      names.forEach((name) => {
        if (!value.availableModels.has(name)) {
          value.availableModels.add(name)
          changed = true
        }
      })
    }
    if (value.available_models instanceof Set) {
      names.forEach((name) => {
        if (!value.available_models.has(name)) {
          value.available_models.add(name)
          changed = true
        }
      })
    }
    if (Array.isArray(value.availableModels)) {
      names.forEach((name) => {
        if (!value.availableModels.includes(name)) {
          value.availableModels.push(name)
          changed = true
        }
      })
    }
    if (Array.isArray(value.available_models)) {
      names.forEach((name) => {
        if (!value.available_models.includes(name)) {
          value.available_models.push(name)
          changed = true
        }
      })
    }
    if (Array.isArray(value.hiddenModels)) {
      const before = value.hiddenModels.length
      value.hiddenModels = value.hiddenModels.filter((name) => !names.includes(name))
      if (value.hiddenModels.length !== before) changed = true
    }
    if (Array.isArray(value.hidden_models)) {
      const before = value.hidden_models.length
      value.hidden_models = value.hidden_models.filter((name) => !names.includes(name))
      if (value.hidden_models.length !== before) changed = true
    }
    if (value.defaultModel == null && names.length > 0) {
      value.defaultModel = codexPlusModelDescriptor(names[0])
      changed = true
    } else if (typeof value.defaultModel === 'string' && names.includes(value.defaultModel) && value.model == null) {
      value.model = value.defaultModel
      changed = true
    }
    return changed
  }

  /** 递归遍历对象图寻找 model 容器（深度 5 限制 + WeakSet 防环） */
  function patchObjectGraphForModels(root, visited, depth = 0) {
    if (!root || typeof root !== 'object' || visited.has(root) || depth > 5) return false
    visited.add(root)
    let changed = patchModelContainer(root)
    if (
      root instanceof Element ||
      root === window ||
      root === document ||
      root === document.body ||
      root === document.documentElement
    )
      return changed
    for (const key of Object.keys(root)) {
      if (
        key === 'ownerDocument' ||
        key === 'parentElement' ||
        key === 'parentNode' ||
        key === 'children' ||
        key === 'childNodes'
      )
        continue
      let value
      try {
        value = root[key]
      } catch {
        continue
      }
      if (value && typeof value === 'object' && patchObjectGraphForModels(value, visited, depth + 1)) changed = true
    }
    return changed
  }

  // ============================================================
  // PATCH 路径 1: Response.prototype.json 全局拦截
  // ============================================================

  async function patchModelJsonResponse(payload) {
    if (!codexPlusModelUnlockEnabled()) return payload
    if (!codexPlusModelNames().length) await loadCodexModelCatalog()
    if (!payload || typeof payload !== 'object') return payload
    try {
      patchModelContainer(payload)
      patchObjectGraphForModels(payload, new WeakSet(), 0)
    } catch (error) {
      window.__copilotBridgeModelPatchFailures = window.__copilotBridgeModelPatchFailures || []
      window.__copilotBridgeModelPatchFailures.push(String(error?.stack || error))
    }
    return payload
  }

  function installModelJsonResponsePatch() {
    if (window.__copilotBridgeModelJsonResponsePatchInstalled === '1') return
    window.__copilotBridgeModelJsonResponsePatchInstalled = '1'
    window.__copilotBridgeModelJsonResponseOriginals = window.__copilotBridgeModelJsonResponseOriginals || {}
    const originals = window.__copilotBridgeModelJsonResponseOriginals
    originals.responseJson = originals.responseJson || Response.prototype.json
    if (typeof originals.responseJson !== 'function') return
    Response.prototype.json = async function copilotBridgePatchedResponseJson(...args) {
      const payload = await originals.responseJson.apply(this, args)
      return await patchModelJsonResponse(payload)
    }
  }

  // ============================================================
  // PATCH 路径 2: app-server-manager-signals chunk sendRequest
  // ============================================================

  function appServerModelRequestMethod(method, params) {
    if (method === 'send-cli-request-for-host' && params?.method) return String(params.method)
    if (method === 'vscode://codex/list-plugins') return 'list-plugins'
    if (method === 'vscode://codex/plugin/install') return 'install-plugin'
    if (method === 'vscode://codex/plugin/uninstall') return 'uninstall-plugin'
    if (method === 'plugin/list') return 'list-plugins'
    if (method === 'plugin/install') return 'install-plugin'
    if (method === 'plugin/uninstall') return 'uninstall-plugin'
    return String(method || '')
  }

  function patchAppServerModelResult(method, result) {
    if (method !== 'list-models-for-host') return result
    try {
      if (Array.isArray(result)) patchModelArray(result, true)
      if (Array.isArray(result?.data)) patchModelArray(result.data, true)
      if (Array.isArray(result?.models)) patchModelArray(result.models, true)
      patchModelContainer(result)
      patchObjectGraphForModels(result, new WeakSet(), 0)
    } catch (error) {
      window.__copilotBridgeModelPatchFailures = window.__copilotBridgeModelPatchFailures || []
      window.__copilotBridgeModelPatchFailures.push(String(error?.stack || error))
    }
    return result
  }

  function patchAppServerModelRequestClient(client) {
    if (!client || typeof client.sendRequest !== 'function') return false
    if (client.__copilotBridgeModelRequestPatch === codexAppServerModelRequestPatchVersion) return true
    const originalSendRequest = client.__copilotBridgeModelOriginalSendRequest || client.sendRequest.bind(client)
    client.__copilotBridgeModelOriginalSendRequest = originalSendRequest
    client.sendRequest = async function copilotBridgeModelPatchedSendRequest(method, params, options) {
      const result = await originalSendRequest(method, params, options)
      if (!codexPlusModelUnlockEnabled()) return result
      if (!codexPlusModelNames().length) await loadCodexModelCatalog()
      return patchAppServerModelResult(appServerModelRequestMethod(String(method || ''), params), result)
    }
    client.__copilotBridgeModelRequestPatch = codexAppServerModelRequestPatchVersion
    return true
  }

  function installAppServerModelRequestPatch() {
    if (window.__copilotBridgeAppServerModelRequestPatchInstalled === codexAppServerModelRequestPatchVersion) return
    const patch = async () => {
      try {
        const module = await loadCodexAppModule(APP_SERVER_CHUNK)
        const candidates = Object.values(module).filter((value) => value && typeof value === 'object')
        let patchedCount = 0
        for (const candidate of candidates) {
          if (patchAppServerModelRequestClient(candidate)) patchedCount += 1
          if (typeof candidate.sendRequest !== 'function' && typeof candidate.get === 'function') {
            try {
              if (patchAppServerModelRequestClient(candidate.get())) patchedCount += 1
            } catch {
              // 忽略 candidate.get() 抛错
            }
          }
        }
        if (patchedCount > 0) {
          window.__copilotBridgeAppServerModelRequestPatchInstalled = codexAppServerModelRequestPatchVersion
          console.log(`[copilot-bridge] app-server model request patched: ${patchedCount} clients`)
        }
      } catch (error) {
        // 静默 — 未来 Codex 升级改了 chunk 名会走这里，其他 patch 路径仍能工作
        console.warn('[copilot-bridge] app-server model request patch failed:', error?.message)
      }
    }
    void patch()
  }

  // ============================================================
  // PATCH 路径 3: window.dispatchEvent + message 监听（MCP）
  // ============================================================

  function patchMcpModelResponseData(data) {
    if (data?.type !== 'mcp-response') return false
    const message = data.message || data.response
    const requestId = message?.id != null ? String(message.id) : ''
    if (codexPlusModelListRequestIds.size > 0 && !codexPlusModelListRequestIds.has(requestId)) return false
    codexPlusModelListRequestIds.delete(requestId)
    return (
      patchModelContainer(data) ||
      patchModelContainer(message) ||
      patchModelContainer(message?.result) ||
      patchModelContainer(message?.result?.data)
    )
  }

  function patchAppServerModelMessages() {
    if (window.__copilotBridgeModelMessagePatchInstalled) return
    window.__copilotBridgeModelMessagePatchInstalled = true
    const originalDispatchEvent = window.dispatchEvent
    window.dispatchEvent = function patchedCopilotBridgeDispatchEvent(event) {
      try {
        const detail = event?.detail
        const request = detail?.request
        if (
          event?.type === 'codex-message-from-view' &&
          detail?.type === 'mcp-request' &&
          request?.method === 'model/list'
        ) {
          request.params = { ...(request.params || {}), includeHidden: true }
          if (request.id != null) codexPlusModelListRequestIds.add(String(request.id))
        }
        if (event?.type === 'message') patchMcpModelResponseData(event.data)
      } catch (error) {
        window.__copilotBridgeModelPatchFailures = window.__copilotBridgeModelPatchFailures || []
        window.__copilotBridgeModelPatchFailures.push(String(error?.stack || error))
      }
      return originalDispatchEvent.call(this, event)
    }

    window.addEventListener(
      'message',
      (event) => {
        try {
          patchMcpModelResponseData(event?.data)
        } catch (error) {
          window.__copilotBridgeModelPatchFailures = window.__copilotBridgeModelPatchFailures || []
          window.__copilotBridgeModelPatchFailures.push(String(error?.stack || error))
        }
      },
      true,
    )
  }

  // ============================================================
  // PATCH 路径 4: Statsig dynamic config (id 107580212)
  // ============================================================

  function statsigClients() {
    const root = window.__STATSIG__ || globalThis.__STATSIG__
    if (!root || typeof root !== 'object') return []
    const clients = [root.firstInstance, typeof root.instance === 'function' ? root.instance() : null]
    if (root.instances && typeof root.instances === 'object') clients.push(...Object.values(root.instances))
    return clients.filter((client, index, array) => client && typeof client === 'object' && array.indexOf(client) === index)
  }

  function patchStatsigModelDynamicConfig(config) {
    const names = codexPlusModelNames()
    const value = config?.value
    if (!names.length || !value || typeof value !== 'object') return config
    const availableModels = Array.isArray(value.available_models) ? [...value.available_models] : []
    let changed = false
    names.forEach((name) => {
      if (!availableModels.includes(name)) {
        availableModels.push(name)
        changed = true
      }
    })
    const nextValue = {
      ...value,
      available_models: availableModels,
      default_model: names[0] || value.default_model,
    }
    if (!changed && nextValue.default_model === value.default_model) return config
    try {
      config.value = nextValue
    } catch {
      return { ...config, value: nextValue }
    }
    return config
  }

  function patchStatsigModelWhitelist() {
    statsigClients().forEach((client) => {
      if (typeof client.getDynamicConfig !== 'function') return
      if (!client.__copilotBridgeModelWhitelistPatched) {
        const originalGetDynamicConfig = client.getDynamicConfig.bind(client)
        client.getDynamicConfig = (name, options) => {
          const result = originalGetDynamicConfig(name, options)
          return patchStatsigModelDynamicConfig(result)
        }
        client.__copilotBridgeModelWhitelistPatched = true
      }
      try {
        patchStatsigModelDynamicConfig(client.getDynamicConfig(STATSIG_MODEL_CONFIG_ID, { disableExposureLog: true }))
      } catch {
        // 忽略 — Statsig 未初始化
      }
    })
  }

  // ============================================================
  // PATCH 路径 5: React Fiber 直改 props (兜底)
  // ============================================================

  function reactFiberKeys(element) {
    return Object.keys(element).filter(
      (key) => key.startsWith('__reactFiber') || key.startsWith('__reactInternalInstance') || key.startsWith('__reactProps'),
    )
  }

  function isWorkspaceChromeNode(node) {
    if (!node || node.nodeType !== 1) return false
    if (
      node.closest?.(
        '[data-app-action-sidebar-section-heading="Chats"], [data-app-action-sidebar-section-heading="Projects"], [data-app-action-sidebar-thread-id], [data-app-action-sidebar-project-row], [data-app-action-sidebar-project-id]',
      )
    ) {
      return false
    }
    return !!node.closest?.('main aside')
  }

  function patchReactModelStateNodes() {
    const selector = "[role='menu'], [role='dialog'], [role='listbox'], [data-radix-popper-content-wrapper]"
    return [document.body, ...document.querySelectorAll(selector)].filter(
      (node) => node && !isWorkspaceChromeNode(node),
    )
  }

  function patchReactModelState() {
    const visited = new WeakSet()
    const nodes = patchReactModelStateNodes()
    let changed = false
    for (const node of nodes.slice(0, 220)) {
      for (const key of reactFiberKeys(node)) {
        if (patchObjectGraphForModels(node[key], visited)) changed = true
      }
    }
    return changed
  }

  function shouldScheduleReactModelStatePatch(mutations) {
    if (!codexPlusModelUnlockEnabled() || !codexPlusModelNames().length) return false
    if (!mutations) return false
    const selector = "[role='menu'], [role='dialog'], [role='listbox'], [data-radix-popper-content-wrapper]"
    return mutations.some((mutation) =>
      [...mutation.addedNodes].some((node) => {
        if (node.nodeType !== 1 || isWorkspaceChromeNode(node)) return false
        return !!node.matches?.(selector) || !!node.querySelector?.(selector)
      }),
    )
  }

  // ============================================================
  // 统一安装入口 + 周期刷新调度
  // ============================================================

  function ensureCodexModelWhitelistInstalls() {
    if (!codexPlusModelUnlockEnabled()) return
    installModelJsonResponsePatch()
    patchAppServerModelMessages()
    installAppServerModelRequestPatch()
  }

  function runCodexModelWhitelistRefreshPass() {
    if (!codexPlusModelUnlockEnabled() || !codexPlusModelNames().length) return false
    let changed = false
    try {
      patchStatsigModelWhitelist()
      if (patchReactModelState()) changed = true
      installAppServerModelRequestPatch()
    } catch (error) {
      window.__copilotBridgeModelPatchFailures = window.__copilotBridgeModelPatchFailures || []
      window.__copilotBridgeModelPatchFailures.push(String(error?.stack || error))
    }
    return changed
  }

  function scheduleCodexModelWhitelistRefresh(durationMs = 2500) {
    if (!codexPlusModelUnlockEnabled()) return
    codexModelWhitelistRefreshUntil = Math.max(codexModelWhitelistRefreshUntil, Date.now() + durationMs)
    if (codexModelWhitelistRefreshTimer) return
    const tick = () => {
      codexModelWhitelistRefreshTimer = 0
      runCodexModelWhitelistRefreshPass()
      if (Date.now() < codexModelWhitelistRefreshUntil) {
        codexModelWhitelistRefreshTimer = window.setTimeout(tick, 120)
      }
    }
    tick()
  }

  function refreshCodexModelWhitelistFromScan(mutations) {
    ensureCodexModelWhitelistInstalls()
    if (!codexPlusModelNames().length) {
      loadCodexModelCatalog()
      return
    }
    if (shouldScheduleReactModelStatePatch(mutations)) {
      scheduleCodexModelWhitelistRefresh()
    } else {
      runCodexModelWhitelistRefreshPass()
    }
  }

  // ============================================================
  // 启动逻辑
  // ============================================================

  // 1. 安装所有 patch
  ensureCodexModelWhitelistInstalls()

  // 2. 立即拉一次 catalog
  loadCodexModelCatalog()

  // 3. MutationObserver 监听 DOM 变化（菜单/弹窗打开时触发 refresh）
  const startObserver = () => {
    if (!document.body) return
    const observer = new MutationObserver((mutations) => {
      refreshCodexModelWhitelistFromScan(mutations)
    })
    observer.observe(document.body, { childList: true, subtree: true })
  }
  if (document.body) {
    startObserver()
  } else {
    document.addEventListener('DOMContentLoaded', startObserver)
  }

  // 4. 每 30s 刷一次 catalog（应对 Copilot token 续期导致的模型变化）
  setInterval(() => {
    loadCodexModelCatalog(true).catch(() => {
      // 静默
    })
  }, 30_000)

  // 5. 暴露调试接口给 DevTools 用
  window.__copilotBridge = {
    getCatalog: () => codexModelCatalog,
    reload: () => loadCodexModelCatalog(true),
    refresh: () => runCodexModelWhitelistRefreshPass(),
    failures: () => window.__copilotBridgeModelPatchFailures || [],
  }

  console.log('[copilot-bridge] all patches installed, catalog loading...')
})()
