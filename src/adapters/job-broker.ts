// A job broker hands the task queue adapter jobs from named queues and
// acknowledges them. Queue names are logical lane names the broker maps to
// its own addresses (e.g. an SQS queue URL), so metrics and logs stay readable.

export interface BrokerJob<T> {
  // Logical name of the queue the job came from
  queue: string
  // Broker-specific handle for this delivery (e.g. an SQS receipt handle)
  id: string
  data: T
  // How many times the broker has delivered this job, when it knows (1 = first delivery)
  receiveCount?: number
}

export interface IJobBroker<T> {
  // First available job over the given queues, tried in that order. The job
  // is claimed (hidden from other consumers) when returned. `null` when every
  // queue is empty.
  claim(queues: string[]): Promise<BrokerJob<T> | null>
  // The job is done (or failed permanently on its content): never deliver it again.
  complete(job: BrokerJob<T>): Promise<void>
  // The job failed for a reason a retry can fix: hand it back for a later redelivery.
  fail(job: BrokerJob<T>, error?: string): Promise<void>
  // Hand an unprocessed job back right away (the consumer is stopping). Falls back to `fail`.
  release?(job: BrokerJob<T>): Promise<void>
  // Enqueue a new job (`--entityId` one-offs, the manual queue CLI).
  send?(queue: string, data: T): Promise<string>
  // Stop claiming (abort an in-progress poll) and hand every in-flight job back.
  stop?(): Promise<void>
}
