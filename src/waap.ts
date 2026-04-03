/**
 * WaaP (Wallet as a Protocol) provider registration.
 * Registers WaaP as a default Sui Wallet Standard provider so it
 * appears in the SKI modal without any extra wallet extension.
 *
 * Docs: https://docs.waap.xyz/guides-sui/start
 */

import { initWaaPSui } from '@human.tech/waap-sdk';
import { registerWallet } from '@wallet-standard/wallet';

const WAAP_ICON = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMjgiIGhlaWdodD0iMTI4Ij48ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9ImciIHgxPSIwIiB5MT0iMCIgeDI9IjEiIHkyPSIxIj48c3RvcCBvZmZzZXQ9IjAlIiBzdG9wLWNvbG9yPSIjNjM2NmYxIi8+PHN0b3Agb2Zmc2V0PSIxMDAlIiBzdG9wLWNvbG9yPSIjYTg1NWY3Ii8+PC9saW5lYXJHcmFkaWVudD48L2RlZnM+PHJlY3Qgd2lkdGg9IjEyOCIgaGVpZ2h0PSIxMjgiIGZpbGw9InVybCgjZykiIHJ4PSIyNCIvPjxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKDE0LDE0KSBzY2FsZSgxKSI+PHBhdGggZmlsbC1ydWxlPSJldmVub2RkIiBjbGlwLXJ1bGU9ImV2ZW5vZGQiIGQ9Ik02Mi4xOCAwQzY3LjYzIDAgNzEuNjUgMy4xIDc0LjQ4IDcuMDljMi41OCAzLjY0IDQuMzcgOC4yNiA1LjY0IDEyLjc3IDQuNTEgMS4yNiA5LjEzIDMuMDQgMTIuNzcgNS42MiAzLjk5IDIuODMgNy4xIDYuODUgNy4xIDEyLjMgMCA1LjAyLTIuNTUgOS4wNy02Ljg4IDEyLjIgNC4zMyAzLjEzIDYuODggNy4xOCA2Ljg5IDEyLjIgMCA1LjQ1LTMuMSA5LjQ3LTcuMDkgMTIuMy0zLjY0IDIuNTgtOC4yNiA0LjM3LTEyLjc3IDUuNjQtMS4yNiA0LjUyLTMuMDQgOS4xNC01LjYyIDEyLjc4LTIuODMgMy45OS02Ljg1IDcuMS0xMi4zIDcuMS01LjAyIDAtOS4wNy0yLjU1LTEyLjItNi44OC0zLjEzIDQuMzMtNy4xOCA2Ljg4LTEyLjIgNi44OS01LjQ1IDAtOS40Ny0zLjEtMTIuMy03LjA5LTIuNTgtMy42NC00LjM3LTguMjYtNS42NC0xMi43Ny00LjUxLTEuMjYtOS4xMy0zLjA1LTEyLjc3LTUuNjJDMy4xMiA3MS42OSAwIDY3LjY3IDAgNjIuMjJjMC01LjAyIDIuNTUtOS4wNyA2Ljg5LTEyLjJDMi41NiA0Ni44OSAwIDQyLjg0IDAgMzcuODIgMCAzMi4zNyAzLjEgMjguMzUgNy4wOSAyNS41MmMzLjY0LTIuNTggOC4yNi00LjM3IDEyLjc3LTUuNjQgMS4yNi00LjUyIDMuMDQtOS4xNCA1LjYyLTEyLjc4QzI4LjMxIDMuMTEgMzIuMzMgMC4wMSAzNy43OCAwLjAxYzUuMDIgMCA5LjA3IDIuNTUgMTIuMiA2Ljg4QzUzLjExIDIuNTYgNTcuMTYgMCA2Mi4xOCAwem0wIDUuNjJjLTMuMjcgMC02LjMyIDEuODQtOS4wMyA2Ljc2LTEuMzcgMi40OC00Ljk1IDIuNDgtNi4zMiAwLTIuNzItNC45Mi01Ljc4LTYuNzYtOS4wNC02Ljc2LTMuMDEgMC01LjUyIDEuNjMtNy43MiA0LjczLTIuMjMgMy4xNC0zLjg5IDcuNS01LjA0IDEyLjEtLjMzIDEuMjUtMS4zIDIuMjItMi41NCAyLjU1LTQuNiAxLjIxLTguOTUgMi44Ny0xMi4xIDUuMUM3LjI0IDMyLjMgNS42MiAzNC44MSA1LjYyIDM3LjgyYzAgMy4yNyAxLjg0IDYuMzIgNi43NiA5LjA0IDIuNDggMS4zNyAyLjQ4IDQuOTUgMCA2LjMyLTQuOTIgMi43Mi02Ljc2IDUuNzgtNi43NiA5LjA0IDAgMy4wMSAxLjYzIDUuNTIgNC43MyA3LjcyIDMuMTQgMi4yMyA3LjUgMy44OSAxMi4xIDUuMDggMS4xNy4zIDIuMSAxLjE4IDIuNDggMi4zMWwuMDcuMjMuMjMuODZjMS4xOSA0LjI4IDIuNzggOC4yOSA0Ljg3IDExLjI0IDIuMiAzLjEgNC43MSA0LjcyIDcuNzIgNC43MiAzLjI3IDAgNi4zMi0xLjg0IDkuMDQtNi43N2wuMTMtLjIyYzEuNDEtMi4xOCA0LjY0LTIuMTggNi4wNSAwbC4xMy4yMi4yNi40NWMyLjY1IDQuNTggNS42MiA2LjMxIDguNzggNi4zMSAzLjAxIDAgNS41Mi0xLjYzIDcuNzItNC43MiAyLjIzLTMuMTQgMy44OS03LjUgNS4wOC0xMi4xLjMzLTEuMjUgMS4zLTIuMjIgMi41NC0yLjU1IDQuNi0xLjIxIDguOTUtMi44NyAxMi4xLTUuMSAzLjEtMi4yIDQuNzItNC43MSA0LjcyLTcuNzIgMC0zLjI3LTEuODQtNi4zMi02Ljc3LTkuMDQtMi40OC0xLjM3LTIuNDgtNC45NSAwLTYuMzJsLjQ1LS4yNmM0LjU4LTIuNjUgNi4zMS01LjYyIDYuMzEtOC43OCAwLTMuMDEtMS42My01LjUyLTQuNzMtNy43Mi0zLjE0LTIuMjMtNy41LTMuODktMTIuMS01LjA0LTEuMjUtLjMyLTIuMjItMS4zLTIuNTQtMi41NC0xLjIxLTQuNi0yLjg3LTguOTUtNS4xLTEyLjEtMi4yLTMuMS00LjcxLTQuNzItNy43Mi00LjcyeiIgZmlsbD0id2hpdGUiLz48cGF0aCBkPSJNNjIuNjcgNjMuMTVjLjk1LTEuMjMgMi43MS0xLjQ2IDMuOTQtLjUxIDEuMjMuOTUgMS40NiAyLjcxLjUxIDMuOTQtMy4xOSA0LjE1LTguOTggNi45Ni0xNS4xNSA3LjQ4LTYuMjcuNTMtMTMuMjYtMS4yNy0xOC44NS02Ljc5LTEuMS0xLjA5LTEuMTEtMi44Ny0uMDItMy45NyAxLjA5LTEuMSAyLjg3LTEuMTEgMy45Ny0uMDIgNC4yNyA0LjIxIDkuNTcgNS42IDE0LjQzIDUuMTkgNC45Ni0uNDIgOS4xNC0yLjY3IDExLjE3LTUuMzJ6IiBmaWxsPSJ3aGl0ZSIvPjxwYXRoIGQ9Ik0zOS42NiAzMC44NGMxLjQ0IDAgMi41NS43MyAzLjI4IDEuNDguNzIuNzQgMS4yNCAxLjY3IDEuNjIgMi41OS43NiAxLjg1IDEuMTcgNC4yMSAxLjE3IDYuNjcgMCAyLjQ2LS40IDQuODMtMS4xNiA2LjY4LS4zOC45Mi0uOSAxLjg1LTEuNjIgMi41OS0uNzMuNzUtMS44NCAxLjQ4LTMuMjggMS40OC0xLjQ0IDAtMi41NS0uNzItMy4yOC0xLjQ3LS43Mi0uNzQtMS4yNC0xLjY3LTEuNjItMi41OS0uNzYtMS44NS0xLjE3LTQuMjEtMS4xNy02LjY3IDAtMi40Ni40LTQuODMgMS4xNi02LjY4LjM4LS45Mi45LTEuODUgMS42Mi0yLjU5LjczLS43NSAxLjg0LTEuNDggMy4yOC0xLjQ4eiIgZmlsbD0id2hpdGUiLz48cGF0aCBkPSJNNjAuMzMgMzAuODRsLjI3LjAxYzEuMzEuMDggMi4zMy43NiAzLjAxIDEuNDcuNzIuNzQgMS4yNCAxLjY3IDEuNjIgMi41OS43NiAxLjg1IDEuMTcgNC4yMSAxLjE3IDYuNjcgMCAyLjQ2LS40IDQuODMtMS4xNiA2LjY4LS4zOC45Mi0uOSAxLjg1LTEuNjIgMi41OS0uNzMuNzUtMS44NCAxLjQ4LTMuMjggMS40OC0xLjQ0IDAtMi41NS0uNzItMy4yOC0xLjQ3LS43Mi0uNzQtMS4yNC0xLjY3LTEuNjItMi41OS0uNzYtMS44NS0xLjE3LTQuMjEtMS4xNy02LjY3IDAtMi40Ni40LTQuODMgMS4xNi02LjY4LjM4LS45Mi45LTEuODUgMS42Mi0yLjU5LjczLS43NSAxLjg0LTEuNDggMy4yOC0xLjQ4eiIgZmlsbD0id2hpdGUiLz48L2c+PC9zdmc+Cg==' as `data:image/svg+xml;base64,${string}`;

let registered = false;
let waapWallet: ReturnType<typeof initWaaPSui> | null = null;

/** Get the WaaP wallet instance (null if not registered) */
export function getWaaPWallet() { return waapWallet; }

export async function registerWaaP(): Promise<void> {
  if (registered || typeof window === 'undefined') return;
  registered = true;

  // Preflight: bail early if WaaP servers are unreachable
  try {
    const res = await fetch('https://waap.xyz/iframe', { method: 'HEAD', mode: 'no-cors' });
    // mode: no-cors gives opaque response — type 'opaque' means server responded
    // If the fetch itself rejects, server is down
    void res;
  } catch {
    registered = false;
    console.warn('[.SKI] WaaP servers unreachable, skipping registration');
    return;
  }

  try {
    const wallet = initWaaPSui({
      useStaging: false,
      config: {
        styles: { darkMode: true },
        authenticationMethods: ['social', 'email', 'phone'],
        allowedSocials: ['twitter', 'google', 'discord', 'github'],
      },
    });
    // Override the built-in icon with our custom branded SVG
    Object.defineProperty(wallet, 'icon', { value: WAAP_ICON, writable: false, enumerable: true, configurable: true });
    registerWallet(wallet as unknown as Parameters<typeof registerWallet>[0]);
  } catch (err) {
    registered = false;
    console.warn('[.SKI] WaaP registration failed:', err);
  }
}
