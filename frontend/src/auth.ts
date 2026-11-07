import { createClient } from '@supabase/supabase-js'

export const cloudAuth = import.meta.env.VITE_AUTH_MODE === 'supabase'
const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
if (cloudAuth && (!url || !key || key.startsWith('sb_secret_'))) {
  throw new Error('Configure the Supabase URL and public publishable key before building the frontend.')
}
export const supabase = cloudAuth ? createClient(url, key) : null
const backendOrigin = (import.meta.env.VITE_API_ORIGIN ?? '').replace(/\/$/, '')
export const apiUrl = (path: string) => `${backendOrigin}/api/${path}`

export async function authHeaders(): Promise<Record<string, string>> {
  if (!supabase) return {}
  const { data, error } = await supabase.auth.getSession()
  if (error) throw error
  return data.session ? { Authorization: `Bearer ${data.session.access_token}` } : {}
}

export const apiCredentials: RequestCredentials = cloudAuth ? 'omit' : 'same-origin'
