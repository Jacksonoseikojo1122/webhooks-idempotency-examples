import { Router } from 'express'
import getRawBody from 'raw-body'
import crypto from 'crypto'
import { hasSeen, markSeen } from './store.js'

const router = Router()

router.post('/paystack', async (req,res)=>{
  const secret = process.env.PAYSTACK_SECRET||''
  const raw = (await getRawBody(req)).toString('utf8')
  const signature = req.header('x-paystack-signature')||''
  const hash = crypto.createHmac('sha512', secret).update(raw).digest('hex')
  if(hash!==signature) return res.status(400).send('Invalid signature')
  const event = JSON.parse(raw)
  const key = `paystack:${event?.event||'evt'}:${event?.data?.reference||'ref'}`
  if(hasSeen(key)) return res.status(200).send('duplicate')
  markSeen(key)
  return res.status(200).json({ ok:true })
})

router.post('/flutterwave', async (req,res)=>{
  const raw = (await getRawBody(req)).toString('utf8')
  const verif = req.header('verif-hash')||''
  const expected = process.env.FLW_HASH||''
  if(!expected || verif!==expected) return res.status(400).send('Invalid signature')
  const event = JSON.parse(raw)
  const key = `flw:${event?.event||'evt'}:${event?.data?.tx_ref || event?.data?.id || 'ref'}`
  if(hasSeen(key)) return res.status(200).send('duplicate')
  markSeen(key)
  return res.status(200).json({ ok:true })
})

export default router