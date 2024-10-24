// Copyright 2018-2022 the oak authors. All rights reserved. MIT license.

import { type Application } from "./application.ts";
import { deferred, Status, STATUS_TEXT } from "./deps.ts";
import { HttpRequest } from "./http_request.ts";
import type { Listener, Server } from "./types.d.ts";
import { assert } from "./util.ts";

type ServeHandler = (
  request: Request,
) => Response | Promise<Response> | void | Promise<void>;

interface ServeInit {
  port?: number;
  hostname?: string;
  signal?: AbortSignal;
  onError?: (error: unknown) => Response | Promise<Response>;
  onListen?: (params: { hostname: string; port: number }) => void;
}

interface ServeTlsInit extends ServeInit {
  cert: string;
  key: string;
}

type FlashServerOptions = Omit<Partial<ServeTlsInit>, "onListen" | "signal">;

const serve: (
  handler: ServeHandler,
  options?: ServeInit,
) => Promise<void> = "serve" in Deno
  // deno-lint-ignore no-explicit-any
  ? (Deno as any).serve.bind(Deno)
  : undefined;

const serveTls: (
  handler: ServeHandler,
  options?: ServeTlsInit,
) => Promise<void> = "serveTls" in Deno
  // deno-lint-ignore no-explicit-any
  ? (Deno as any).serveTls.bind(Deno)
  : undefined;

function isServeTlsInit(
  value: ServeInit | ServeTlsInit,
): value is ServeTlsInit {
  return "cert" in value && "key" in value;
}

/** A function that determines if the current environment supports Deno flash.*/
export function hasFlash(): boolean {
  // @ts-expect-error they might not actually be defined!
  return !!(serve && serveTls);
}

/** A server abstraction which manages requests from Deno's flash server.
 *
 * You can pass the class as the `server` property when constructing a new
 * application to force the application to use Deno's flash server.
 */
export class FlashServer implements Server<HttpRequest> {
  // deno-lint-ignore no-explicit-any
  #app: Application<any>;
  #closed = false;
  #controller?: ReadableStreamDefaultController<HttpRequest>;
  #abortController = new AbortController();
  #options: FlashServerOptions;
  #servePromise?: Promise<void>;
  #stream?: ReadableStream<HttpRequest>;

  // deno-lint-ignore no-explicit-any
  constructor(app: Application<any>, options: FlashServerOptions) {
    if (!serve || !serveTls) {
      throw new Error("The flash bindings for serving HTTP are not available.");
    }
    this.#app = app;
    this.#options = options;
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    try {
      this.#controller?.close();
      this.#controller = undefined;
      this.#stream = undefined;
      this.#abortController.abort();
      if (this.#servePromise) {
        await this.#servePromise;
        this.#servePromise = undefined;
      }
    } catch {
      // just swallow here
    }
  }

  listen(): Promise<Listener> {
    const p = deferred<Listener>();
    const start: ReadableStreamDefaultControllerCallback<HttpRequest> = (
      controller,
    ) => {
      this.#controller = controller;
      const options: ServeInit | ServeTlsInit = {
        ...this.#options,
        signal: this.#abortController.signal,
        onListen: (addr) => p.resolve({ addr }),
        onError: (error) => {
          this.#app.dispatchEvent(new ErrorEvent("error", { error }));
          return new Response("Internal server error", {
            status: Status.InternalServerError,
            statusText: STATUS_TEXT[Status.InternalServerError],
          });
        },
      };
      const handler: ServeHandler = (request) => {
        const resolve = deferred<Response>();
        const flashRequest = new HttpRequest(request, resolve);
        controller.enqueue(flashRequest);
        return resolve;
      };
      if (isServeTlsInit(options)) {
        this.#servePromise = serveTls(handler, options);
      } else {
        this.#servePromise = serve(handler, options);
      }
    };
    this.#stream = new ReadableStream({ start });
    return p;
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<HttpRequest> {
    assert(
      this.#stream,
      ".listen() was not called before iterating or server is closed.",
    );
    return this.#stream[Symbol.asyncIterator]();
  }
}
