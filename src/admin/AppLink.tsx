import type { AnchorHTMLAttributes, ReactNode } from "react";
import { opensElsewhere } from "../deep-links";

/**
 * A real link to a console address. A plain click moves inside the application through `onNavigate`; a
 * middle click or a click with a modifier key is left to the browser, which opens the same address in a
 * new tab.
 */
export function AppLink({
  href,
  onNavigate,
  children,
  ...rest
}: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "onClick"> & {
  href: string;
  onNavigate: () => void;
  children: ReactNode;
}) {
  return (
    <a
      {...rest}
      href={href}
      onClick={(event) => {
        if (opensElsewhere(event)) return;
        event.preventDefault();
        onNavigate();
      }}
    >
      {children}
    </a>
  );
}
