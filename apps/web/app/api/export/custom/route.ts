// Route Handler stub — custom
// TODO: implement per Phase 3 Playbook v3.5
import { NextResponse } from 'next/server'
export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json({ error: 'not implemented' }, { status: 501 })
}

export async function POST() {
  return NextResponse.json({ error: 'not implemented' }, { status: 501 })
}
