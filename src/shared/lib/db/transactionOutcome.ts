export class TransactionCommitUnknownError extends Error {
  readonly code = 'COMMIT_OUTCOME_UNKNOWN';

  constructor() {
    super('Не удалось подтвердить результат сохранения. Обновите данные перед повторной попыткой.');
    this.name = 'TransactionCommitUnknownError';
  }
}
