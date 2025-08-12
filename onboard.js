import canonicalize from 'canonicalize'
import { privateKeyToAccount } from 'viem/accounts'
import { toBytes } from 'viem'
import { Buffer } from 'buffer'

const PRIV = '' // custody private key 0x...
const account = privateKeyToAccount(PRIV)

function buildAuthBody() {
  const timestamp = Date.now()
  const expiresAt = timestamp + 1000 * 60 * 60 * 24 // 24 jam
  const payload = {
    authRequest: {
      method: "generateToken",
      params: { timestamp, expiresAt }
    }
  }
  return { payload, canon: canonicalize(payload.authRequest) }
}

function bearer(sigHex) {
  return 'eip191:' + Buffer.from(toBytes(sigHex)).toString('base64')
}

const { payload, canon } = buildAuthBody()
const sig = await account.signMessage({ message: canon })
const authz = bearer(sig)

const res = await fetch('https://client.farcaster.xyz/v2/onboarding-state', {
  method: 'PUT',
  headers: {
    Authorization: `Bearer ${authz}`,
    'Content-Type': 'application/json; charset=utf-8',
  },
  body: JSON.stringify(payload),
})
console.log('status:', res.status)
console.log(await res.json())
