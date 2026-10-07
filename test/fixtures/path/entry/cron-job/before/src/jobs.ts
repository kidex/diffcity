import cron from 'node-cron';

export function nightlyCleanup(): number {
  return 0;
}

export function startJobs(): void {
  cron.schedule('0 3 * * *', nightlyCleanup);
}
