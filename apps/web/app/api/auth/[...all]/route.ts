// Better Auth catch-all handler
// Handles: /api/auth/sign-in/microsoft, /api/auth/callback/microsoft, /api/auth/sign-out
// TODO: wire up once better-auth is configured in lib/auth/auth.ts
// import { auth } from '@/lib/auth/auth'
// import { toNextJsHandler } from 'better-auth/next-js'
// export const { GET, POST } = toNextJsHandler(auth)

import { NextResponse } from 'next/server'
export async function GET() {
  return NextResponse.json({ error: 'auth not yet configured' }, { status: 501 })
}
export async function POST() {
  return NextResponse.json({ error: 'auth not yet configured' }, { status: 501 })
}
