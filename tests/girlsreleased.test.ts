import { describe, it, expect, mock } from "bun:test";
import { girlsreleasedModel } from "../src/hosts/girlsreleased/model";

describe("GirlsReleased Hoster Model", () => {
  it("has correct configuration properties", () => {
    expect(girlsreleasedModel.id).toBe("girlsreleased");
    expect(girlsreleasedModel.displayName).toBe("GirlsReleased");
    expect(girlsreleasedModel.galleryConfig?.galleryMatches).toContain(
      "https://girlsreleased.com/set/*",
    );
  });

  describe("collectAllItems (collectGirlsreleasedItems)", () => {
    const collectAllItems = girlsreleasedModel.galleryConfig?.collectAllItems;
    expect(collectAllItems).toBeDefined();

    it("extracts imx.to links from anchors", () => {
      const mockAnchor = {
        href: "https://imx.to/i/6r3hhr",
      };

      const mockScope = {
        querySelectorAll: (selector: string) => {
          if (selector === "a") {
            return [mockAnchor];
          }
          return [];
        },
        querySelector: () => ({ textContent: "Test Album" }),
      };

      const items = collectAllItems!(mockScope as unknown as Document);
      expect(items).toHaveLength(1);
      expect(items[0]).toEqual({
        kind: "resolve-viewer",
        viewerUrl: "https://imx.to/i/6r3hhr",
        extractor: "continuebutton",
        filename: "test_album_001",
      });
    });
  });

  describe("resolveUrl (resolveGirlsreleasedUrl)", () => {
    const resolveUrl = girlsreleasedModel.galleryConfig?.resolveUrl;
    expect(resolveUrl).toBeDefined();

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
      });

      try {
        const directUrl = await resolveUrl!("continuebutton", "https://imx.to/i/6r3hhr");
        expect(directUrl).toBe("https://image.imx.to/u/i/2026/04/27/6r3hhr.jpg");
      } finally {
        global.fetch = originalFetch;
      }
    });

    it("returns rawUrl if no viewerUrl is provided", async () => {
      const directUrl = await resolveUrl!("someRawUrl");
      expect(directUrl).toBe("someRawUrl");
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
