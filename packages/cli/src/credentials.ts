export interface CredentialStore {
  get(service: string, account: string): Promise<string | null>;
  set(service: string, account: string, secret: string): Promise<void>;
}

export interface CredentialDriver {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, secret: string): Promise<void>;
}

export class OperatingSystemCredentialStore implements CredentialStore {
  constructor(private readonly driver: CredentialDriver) {}

  get(service: string, account: string): Promise<string | null> {
    return this.driver.getPassword(service, account);
  }

  set(service: string, account: string, secret: string): Promise<void> {
    return this.driver.setPassword(service, account, secret);
  }
}

export class UnavailableCredentialStore implements CredentialStore {
  async get(): Promise<string | null> {
    return null;
  }

  async set(): Promise<void> {
    throw new Error("Credential store is unavailable");
  }
}
