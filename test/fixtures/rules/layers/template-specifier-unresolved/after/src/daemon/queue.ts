export interface Job {
  id: string;
}

export function enqueue(job: Job): Job {
  return job;
}
