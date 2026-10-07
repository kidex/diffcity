export class Sweeper {
  @Cron('0 4 * * *')
  sweep(): number {
    return 2;
  }
}
