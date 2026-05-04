import { useState } from 'react'
import './App.css'

const API_BASE = import.meta.env.VITE_API_BASE_URL

function App() {
  const [status, setStatus] = useState<string>('idle')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function testBackend() {
    setStatus('connecting...')
    setError(null)
    setSessionId(null)
    try {
      const res = await fetch(`${API_BASE}/sessions`, { method: 'POST' })
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${await res.text()}`)
      }
      const data = await res.json()
      setSessionId(data.session_id)
      setStatus('connected ✓')
    } catch (err) {
      setStatus('failed')
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div style={{ padding: '2rem', fontFamily: 'sans-serif' }}>
      <h1>CleanShot Frontend</h1>
      <p>API: <code>{API_BASE}</code></p>
      <button onClick={testBackend}>Test backend connection</button>
      <p>Status: <strong>{status}</strong></p>
      {sessionId && <p>Session ID: <code>{sessionId}</code></p>}
      {error && <p style={{ color: 'red' }}>Error: {error}</p>}
    </div>
  )
}

export default App