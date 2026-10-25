import { LiveApi } from "./live";
import { MockApi } from "../mock/api";
import type { Api } from "./types";

const url = (import.meta.env.VITE_API_URL as string | undefined)?.trim();

/** VITE_API_URL set → real backend (use "/" to go through the Vite proxy). Otherwise the in-browser simulator. */
export const api: Api = url ? new LiveApi(url === "/" ? "" : url.replace(/\/$/, "")) : new MockApi();
export * from "./types";
