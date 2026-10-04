import dotenv from 'dotenv'
import { createApp } from './app.js'

dotenv.config({ quiet: true })

const port = Number(process.env.PORT ?? 3005)

createApp().listen(port, () => {
  console.log(`[webhooks] listening on http://localhost:${port}`)
})
