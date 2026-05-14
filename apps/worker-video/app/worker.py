# CleanShot Video Worker — Phase 4.5 stub
# Veo 3.1 video generation — not implemented until Phase 4.5
# max_jobs=20 (mostly asyncio.sleep polling Veo)
# job_timeout=1500s (25 minutes — covers worst-case Veo rendering)
# max_tries=2 — Veo retries cost real money, never burn 5 attempts

class WorkerSettings:
    functions = []
    max_jobs = 20
    job_timeout = 1500
