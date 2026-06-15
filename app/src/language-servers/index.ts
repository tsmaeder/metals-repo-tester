import type { LanguageServer } from "../language-server";
import { intellijLanguageServer } from "./intellij";
import { jdtlsLanguageServer } from "./jdtls";
import { metalsLanguageServer } from "./metals";

const languageServers: { [id: string]: LanguageServer } = {
  metals: metalsLanguageServer,
  jdtls: jdtlsLanguageServer,
  intellij: intellijLanguageServer,
};

export function getLanguageServer(id: string): LanguageServer {
  const server = languageServers[id];
  if (!server) {
    const supported = Object.keys(languageServers).join(", ");
    throw new Error("Unknown language server: " + id + ". Supported: " + supported);
  }
  return server;
}

export function listLanguageServerIds(): string[] {
  return Object.keys(languageServers);
}
