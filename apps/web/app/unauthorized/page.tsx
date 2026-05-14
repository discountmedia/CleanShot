// Shown when user passes Microsoft SSO but fails the allowlist check
export default function UnauthorizedPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-950">
      <div className="flex flex-col items-center gap-4 rounded-2xl border border-white/10 bg-white/5 p-10">
        <h1 className="text-xl font-semibold text-white">Access Denied</h1>
        <p className="text-sm text-neutral-400 text-center max-w-xs">
          Your account is not authorised to use CleanShot.
          Contact your administrator to request access.
        </p>
      </div>
    </main>
  )
}
