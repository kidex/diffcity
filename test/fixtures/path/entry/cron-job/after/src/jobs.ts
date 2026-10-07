import cron from 'node-cron';

export function nightlyCleanup(): number {
  return 1;
}

export function startJobs(): void {
  cron.schedule('0 3 * * *', nightlyCleanup);
}
