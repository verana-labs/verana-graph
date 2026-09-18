import { describe, expect, it } from 'vitest'
import { verifyVpSignature } from '../../src/deref/vpVerify'
import { makeHolder, signVp } from '../harness/vp'

const HOLDER = 'did:webvh:test:holder.example'

describe('TG-DEREF-3 VP signature re-verification', () => {
  it('accepts a VP signed by the holder', async () => {
    const { key, doc } = await makeHolder(HOLDER)
    const vp = await signVp(key, HOLDER)
    const verdict = await verifyVpSignature(vp, HOLDER, async () => doc)
    expect(verdict).toEqual({ verified: true })
  })

  it('rejects a tampered body', async () => {
    const { key, doc } = await makeHolder(HOLDER)
    const vp = await signVp(key, HOLDER)
    vp.holder = 'did:webvh:test:attacker.example'
    const verdict = await verifyVpSignature(vp, HOLDER, async () => doc)
    expect(verdict.verified).toBe(false)
  })

  it('rejects a signer key that is not in the holder DID document', async () => {
    const { key } = await makeHolder(HOLDER)
    const { doc: otherDoc } = await makeHolder(HOLDER)
    const vp = await signVp(key, HOLDER)
    const verdict = await verifyVpSignature(vp, HOLDER, async () => otherDoc)
    expect(verdict.verified).toBe(false)
    expect(verdict.reason).toContain('not in holder DID document')
  })

  it('rejects a proof bound to a different DID', async () => {
    const { key, doc } = await makeHolder(HOLDER)
    const vp = await signVp(key, HOLDER)
    const verdict = await verifyVpSignature(vp, 'did:webvh:test:someone.else', async () => doc)
    expect(verdict.verified).toBe(false)
    expect(verdict.reason).toContain('not the holder DID')
  })

  it('rejects when the DID document is unresolvable', async () => {
    const { key } = await makeHolder(HOLDER)
    const vp = await signVp(key, HOLDER)
    const verdict = await verifyVpSignature(vp, HOLDER, async () => null)
    expect(verdict.verified).toBe(false)
  })
})
