import { brandingCssVars } from "@/lib/branding";

// #764 — CSS custom properties are how a provider's configured colors reach
// the DOM (see globals.css and layout.tsx); this locks the variable names
// so a rename there doesn't silently break theming.
describe("brandingCssVars", () => {
  it("maps primary/secondary colors to the CSS custom properties consumed by globals.css", () => {
    expect(
      brandingCssVars({
        name: "Acme Energy",
        primaryColor: "#112233",
        secondaryColor: "#445566",
      }),
    ).toEqual({
      "--color-brand-primary": "#112233",
      "--color-brand-secondary": "#445566",
    });
  });
});
