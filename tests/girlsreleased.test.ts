import { describe, it, expect, mock } from "bun:test";
import { girlsreleasedModel } from "../src/hosts/girlsreleased/model";
import { resolveLeaf, thumbnailToFull } from "../src/resolvers/index";

describe("GirlsReleased Hoster Model", () => {
  it("has correct configuration properties", () => {
    expect(girlsreleasedModel.id).toBe("girlsreleased");
    expect(girlsreleasedModel.displayName).toBe("GirlsReleased");
    expect(girlsreleasedModel.galleryConfig?.galleryMatches).toContain(
      "https://girlsreleased.com/set/*",
    );
    expect(girlsreleasedModel.galleryConfig?.resolveFromViewer).toBeDefined();
  });

  describe("collectAllItems (collectGirlsreleasedItems)", () => {
    const collectAllItems = girlsreleasedModel.galleryConfig?.collectAllItems;
    expect(collectAllItems).toBeDefined();

    it("emits a single self-referential item on set pages to trigger set expansion", () => {
      const originalWindow = global.window;
      global.window = {
        location: {
          href: "https://girlsreleased.com/set/154616",
          pathname: "/set/154616",
        },
      } as any;

      try {
        const items = collectAllItems!();
        expect(items).toHaveLength(1);
        expect(items[0]).toEqual({
          kind: "resolve-viewer",
          viewerUrl: "https://girlsreleased.com/set/154616",
          filename: "set_placeholder",
        });
      } finally {
        global.window = originalWindow;
      }
    });

    it("extracts set links from anchors on site pages", () => {
      const originalWindow = global.window;
      global.window = {
        location: {
          pathname: "/site/femjoy.com",
        },
      } as any;

      try {
        const mockSetAnchor = {
          href: "https://girlsreleased.com/set/154616",
        };

        const mockScope = {
          querySelectorAll: (selector: string) => {
            if (selector === "a") {
              return [mockSetAnchor];
            }
            return [];
          },
          querySelector: () => ({ textContent: "femjoy.com Sets" }),
        };

        const originalDocument = global.document;
        global.document = mockScope as unknown as Document;

        try {
          const items = collectAllItems!();
          expect(items).toHaveLength(1);
          expect(items[0]).toEqual({
            kind: "resolve-viewer",
            viewerUrl: "https://girlsreleased.com/set/154616",
            filename: "set_placeholder",
          });
        } finally {
          global.document = originalDocument;
        }
      } finally {
        global.window = originalWindow;
      }
    });
  });

  describe("resolveLeaf and leaf resolvers", () => {
    it("returns direct URL from imx.to POST request bypass", async () => {
      const originalFetch = global.fetch;
      global.fetch = mock(async () => {
        return {
          ok: true,
          text: async () => `
            <html>
              <body>
                <img src="https://image.imx.to/u/i/2026/04/27/6r3hhr.jpg" />
              </body>
            </html>
          `,
        } as any;
      }) as unknown as typeof fetch;

      try {
        const result = await resolveLeaf("https://imx.to/i/6r3hhr");
        expect(result).toEqual({
          url: "https://image.imx.to/u/i/2026/04/27/6r3hhr.jpg",
        });
      } finally {
        global.fetch = originalFetch;
      }
    });

    it("returns direct URL and original filename from imx.to POST request bypass when title is present", async () => {
      const originalFetch = global.fetch;
      global.fetch = mock(async () => {
        return {
          ok: true,
          text: async () => `
            <html>
              <head>
                <title>IMX.to / 17944566_tyg186_002.jpg</title>
              </head>
              <body>
                <img src="https://image.imx.to/u/i/2026/04/27/6r3hhr.jpg" />
              </body>
            </html>
          `,
        } as any;
      }) as unknown as typeof fetch;

      try {
        const result = await resolveLeaf("https://imx.to/i/6r3hhr");
        expect(result).toEqual({
          url: "https://image.imx.to/u/i/2026/04/27/6r3hhr.jpg",
          filename: "17944566_tyg186_002.jpg",
        });
      } finally {
        global.fetch = originalFetch;
      }
    });

    it("resolves imagevenue by self-priming cookies", async () => {
      const originalFetch = global.fetch;
      const fetchCalls: { url: string; options?: any }[] = [];

      global.fetch = mock(async (url: string | URL | Request, options?: any) => {
        fetchCalls.push({ url: String(url), options });
        return {
          ok: true,
          text: async () => `
            <html>
              <head>
                <title>ImageVenue - photo.jpg</title>
              </head>
              <body>
                <img class="img-fluid" src="https://cdn-imagevenue.com/12/34/photo.jpg" />
              </body>
            </html>
          `,
        } as any;
      }) as unknown as typeof fetch;

      try {
        const result = await resolveLeaf("https://imagevenue.com/photo");
        expect(result).toEqual({
          url: "https://cdn-imagevenue.com/12/34/photo.jpg",
          filename: "photo.jpg",
        });
        expect(fetchCalls).toHaveLength(2);
        expect(fetchCalls[0]?.options?.cache).toBe("no-store");
        expect(fetchCalls[1]?.options?.cache).toBe("reload");
      } finally {
        global.fetch = originalFetch;
      }
    });

    it("throws error for unsupported hosts", async () => {
      expect(resolveLeaf("https://example.com/image")).rejects.toThrow(
        "no leaf resolver for host: example.com",
      );
    });

    it("transforms imx.to thumbnail URL to full URL via thumbnailToFull", () => {
      const full = thumbnailToFull("https://imx.to/u/t/2026/04/27/6r3hhr.jpg");
      expect(full).toBe("https://imx.to/u/i/2026/04/27/6r3hhr.jpg");
    });

    it("returns null for non-imx thumbnail URLs or invalid URLs", () => {
      expect(thumbnailToFull("https://imagevenue.com/u/t/image.jpg")).toBeNull();
      expect(thumbnailToFull("invalid-url")).toBeNull();
    });
  });

  describe("getGalleryName", () => {
    it("extracts and normalizes site name and set title", () => {
      const mockSiteAnchor = {
        textContent: "  femjoy.com  ",
        getAttribute: (attr: string) => {
          if (attr === "href") return "/site/femjoy.com";
          return null;
        },
        closest: () => null,
      };

      const mockModelAnchor = {
        textContent: "  Ariel A  ",
        getAttribute: (attr: string) => {
          if (attr === "href") return "/site/femjoy.com/model/5208/Ariel A";
          return null;
        },
        closest: () => null,
      };

      const mockH1 = {
        textContent: "  Sway  ",
        getAttribute: () => null,
      };

      const mockDoc = {
        querySelectorAll: (selector: string) => {
          if (selector === "h1") {
            return [mockH1];
          }
          if (selector === 'a[href*="/site/"]') {
            return [mockSiteAnchor, mockModelAnchor];
          }
          return [];
        },
      };

      const name = girlsreleasedModel.getGalleryName!(mockDoc as unknown as Document);
      expect(name).toBe("Femjoy/Ariel A - Sway");
    });

    it("falls back to only the set title if site is not found", () => {
      const mockH1 = {
        textContent: "  Ariel A - Sway  ",
        getAttribute: () => null,
      };

      const mockDoc = {
        querySelectorAll: (selector: string) => {
          if (selector === "h1") {
            return [mockH1];
          }
          return [];
        },
      };

      const name = girlsreleasedModel.getGalleryName!(mockDoc as unknown as Document);
      expect(name).toBe("Ariel A - Sway");
    });
  });
});
