import express from 'express'
import dotenv from 'dotenv'
import webhookRouter from './webhooks.js'
dotenv.config()
const app = express()
app.get('/', (_req,res)=>res.send('Webhooks & Idempotency examples up'))
app.use('/webhooks', webhookRouter)
const port = Number(process.env.PORT||3005)
app.listen(port, ()=>console.log(`[webhooks] http://localhost:${port}`))