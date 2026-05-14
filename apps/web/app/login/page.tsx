// Login page — Microsoft SSO via Better Auth
// Only shown when AUTH_ENABLED=true
// TODO: implement SignInButton component and Better Auth session check
export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-950">
      <div className="flex flex-col items-center gap-6 rounded-2xl border border-white/10 bg-white/5 p-10">
        <h1 className="text-xl font-semibold text-white">CleanShot</h1>
        <p className="text-sm text-neutral-400">
          Sign in with your Microsoft account to continue
        </p>
        {/* TODO: <SignInButton callbackUrl="/" /> */}
        <p className="text-xs text-neutral-600">Auth not yet configured</p>
      </div>
    </main>
  )
}
