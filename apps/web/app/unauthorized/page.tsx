// apps/web/app/unauthorized/page.tsx
// Shown when a valid Microsoft account fails the domain/email allowlist check.

export default function UnauthorizedPage() {
  return (
    <div className="min-h-screen bg-well flex items-center justify-center p-4">
      <div className="w-full max-w-md text-center space-y-6">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-panel border border-danger-ink mb-2">
          <svg className="w-8 h-8 text-danger-ink" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
          </svg>
        </div>

        <div className="space-y-2">
          <h1 className="text-2xl font-bold text-ink">Access Denied</h1>
          <p className="text-ink-soft text-sm leading-relaxed">
            Your Microsoft account was authenticated successfully, but your email
            address is not authorized to access CleanShot.
          </p>
        </div>

        <div className="bg-panel border border-line rounded-xl p-4 text-left space-y-2">
          <p className="text-xs text-ink-faint font-medium uppercase tracking-wider">What to do</p>
          <ul className="text-sm text-ink-soft space-y-1.5">
            <li>• Contact your administrator to request access</li>
            <li>• Make sure you signed in with the correct Microsoft account</li>
            <li>• Your domain or individual email must be on the authorized list</li>
          </ul>
        </div>

        <a
          href="/login"
          className="inline-flex items-center gap-2 text-sm text-ink-soft hover:text-ink-soft transition-colors"
        >
          ← Try a different account
        </a>
      </div>
    </div>
  );
}
