// Root page — redirects to session workspace
// Session creation handled by /api/auth/session route handler
import { redirect } from 'next/navigation'

export default function HomePage() {
  // TODO: create session via BFF, redirect to /session/[sessionId]
  redirect('/login')
}
