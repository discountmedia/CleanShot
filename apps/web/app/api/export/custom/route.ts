// Route Handler stub — custom
// TODO: implement per Phase 3 Playbook v3.5
import { NextRequest, NextResponse } from 'next/server'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  return NextResponse.json({ error: 'not implemented' }, { status: 501 })
}

export async function POST(request: NextRequest) {
  return NextResponse.json({ error: 'not implemented' }, { status: 501 })
}
