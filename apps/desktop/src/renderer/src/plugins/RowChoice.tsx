import type { ComponentProps } from "react";
import { Button } from "../components/ui/button";

/** A plugin row's pick of one among many (the default agent, the view in use): the chosen row says
 *  so, every other one offers it in words while the row is pointed at or focused. */
export function RowChoice({ chosen, said, offer, ...rest }: { chosen: boolean; said: string; offer: string } & Omit<ComponentProps<typeof Button>, "children" | "variant" | "size" | "role">) {
  return (
    <Button size="xs" variant={chosen ? "secondary" : "ghost"} role="radio" aria-checked={chosen} {...rest}
      className={chosen ? undefined : "row-choice-offer"}>
      {chosen ? said : offer}
    </Button>
  );
}
