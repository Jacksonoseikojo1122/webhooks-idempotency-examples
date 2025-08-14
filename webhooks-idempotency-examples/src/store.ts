type Entry = { value: 'seen'; expiresAt: number }
const map = new Map<string, Entry>()
const DEFAULT_TTL_MS = 24*60*60*1000
export function markSeen(key:string, ttlMs:number=DEFAULT_TTL_MS){ map.set(key,{value:'seen',expiresAt:Date.now()+ttlMs}) }
export function hasSeen(key:string){ const e=map.get(key); if(!e) return false; if(Date.now()>e.expiresAt){ map.delete(key); return false } return true }