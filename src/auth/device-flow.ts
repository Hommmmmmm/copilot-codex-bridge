import open from 'open'

/**
 * GitHub Copilot 用的公开 OAuth Client ID（VS Code Copilot 扩展使用，社区共用）
 * 这不是秘密，所有 Copilot 第三方客户端都用同一个
 */
const GITHUB_CLIENT_ID = 'Iv1.b507a08c87ecfe98'

/** GitHub device flow 第一步返回 */
interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}

/** GitHub device flow 第二步轮询返回（成功） */
interface AccessTokenSuccess {
  access_token: string
  token_type: string
  scope: string
}

/** 轮询时的错误返回 */
interface AccessTokenError {
  error: 'authorization_pending' | 'slow_down' | 'expired_token' | 'access_denied' | string
  error_description?: string
}

/**
 * 触发 GitHub OAuth device flow，等用户在浏览器授权后返回 access_token
 * 全流程在终端 + 浏览器交互完成
 */
export async function runDeviceFlow(): Promise<string> {
  // 步骤 1：申请 device code
  const codeRes = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      scope: 'read:user',
    }),
  })

  if (!codeRes.ok) {
    throw new Error(`申请 device code 失败：HTTP ${codeRes.status} ${await codeRes.text()}`)
  }

  const code = (await codeRes.json()) as DeviceCodeResponse

  // 引导用户：显示 user_code + 自动打开浏览器
  console.log('\n=========================================')
  console.log('请在浏览器中粘贴下面的代码完成 GitHub 授权：')
  console.log(`\n  ${code.user_code}\n`)
  console.log(`授权页面：${code.verification_uri}`)
  console.log('（已自动尝试打开浏览器；超时时间 ' + Math.floor(code.expires_in / 60) + ' 分钟）')
  console.log('=========================================\n')

  // 自动打开浏览器，失败也不阻断（用户可手动粘贴）
  try {
    await open(code.verification_uri)
  } catch {
    // 忽略
  }

  // 步骤 2：按 interval 轮询，直到拿到 token 或失败
  const startedAt = Date.now()
  const deadline = startedAt + code.expires_in * 1000
  let interval = code.interval

  while (Date.now() < deadline) {
    await sleep(interval * 1000)

    const pollRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        device_code: code.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    })

    const body = (await pollRes.json()) as AccessTokenSuccess | AccessTokenError

    if ('access_token' in body) {
      console.log('GitHub 授权成功')
      return body.access_token
    }

    // 几种已知错误：pending 继续轮询；slow_down 加大间隔；其他终止
    switch (body.error) {
      case 'authorization_pending':
        process.stdout.write('.')
        continue
      case 'slow_down':
        interval += 5
        process.stdout.write('.')
        continue
      case 'expired_token':
        throw new Error('device code 已过期，请重新运行 login')
      case 'access_denied':
        throw new Error('用户拒绝授权')
      default:
        throw new Error(`device flow 失败：${body.error} ${body.error_description ?? ''}`)
    }
  }

  throw new Error('device flow 超时未完成')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
