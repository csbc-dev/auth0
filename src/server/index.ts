export { createAuthenticatedWSS, handleConnection } from "./createAuthenticatedWSS.js";
export type { HandleConnectionOptions, AuthEvent } from "./createAuthenticatedWSS.js";
export { verifyAuth0Token } from "./verifyAuth0Token.js";
export { extractTokenFromProtocol } from "./extractTokenFromProtocol.js";
export { createAuthConfigHandler } from "./createAuthConfigHandler.js";
export { UserCore } from "./UserCore.js";

export type {
  UserContext,
  AuthenticatedConnectionOptions,
  AuthConfigHandlerOptions,
  ExposeAuthConfigOptions,
  VerifyTokenOptions,
} from "../types.js";
