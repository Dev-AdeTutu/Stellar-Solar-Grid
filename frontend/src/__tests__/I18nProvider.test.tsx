import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "@jest/globals";
import { I18nProvider, useLocale } from "@/components/I18nProvider";

function LocaleProbe() {
  const { locale, setLocale, toggleLocale } = useLocale();
  return (
    <div>
      <output data-testid="locale">{locale}</output>
      <button onClick={() => setLocale("sw")}>set swahili</button>
      <button onClick={toggleLocale}>cycle</button>
    </div>
  );
}

describe("I18nProvider", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("restores a supported Swahili locale from localStorage", async () => {
    window.localStorage.setItem("sg_locale", "sw");

    render(
      <I18nProvider>
        <LocaleProbe />
      </I18nProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("locale")).toHaveTextContent("sw"));
  });

  it("persists explicit selection and cycles through all supported locales", async () => {
    render(
      <I18nProvider>
        <LocaleProbe />
      </I18nProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("locale")).toHaveTextContent("en"));
    fireEvent.click(screen.getByRole("button", { name: "set swahili" }));
    expect(screen.getByTestId("locale")).toHaveTextContent("sw");
    expect(window.localStorage.getItem("sg_locale")).toBe("sw");

    fireEvent.click(screen.getByRole("button", { name: "cycle" }));
    expect(screen.getByTestId("locale")).toHaveTextContent("en");
  });
});
