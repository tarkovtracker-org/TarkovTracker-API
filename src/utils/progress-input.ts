export const MAX_PROGRESS_BODY_BYTES = 256 * 1024;
export const MAX_TASK_UPDATES = 1000;
export const MAX_PROGRESS_ID_LENGTH = 64;
export class ProgressInputError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
    this.name = 'ProgressInputError';
  }
}
export function isProgressId(id: string): boolean {
  return id.length <= MAX_PROGRESS_ID_LENGTH && id.trim().length > 0;
}
