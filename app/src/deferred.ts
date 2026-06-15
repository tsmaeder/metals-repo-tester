export class Deferred<T> {
  private _resolve: (value: T) => void;
  private _reject: (error: Error) => void;
  private _promise: Promise<T>;

  public constructor(timeoutMs? : number) {
    this._promise = new Promise((resolve, reject) => {
      if (timeoutMs) {
        const timer = setTimeout(() => {
          reject(new Error("Timeout"));
        }, timeoutMs);
        this._resolve = (value: T) => {
          clearTimeout(timer);
          resolve(value);
        };
        this._reject = (error: Error) => {
          clearTimeout(timer);
          reject(error);
        }; 
      } else {
        this._resolve = resolve;
        this._reject = reject;
      }
    });
  }

  public resolve(value: T): void {
    this._resolve(value);
  }

  public reject(error: Error): void {
    this._reject(error);
  }

  public promise(): Promise<T> {
    return this._promise;
  }
}   