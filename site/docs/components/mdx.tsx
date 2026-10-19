import { Accordion, Accordions } from 'fumadocs-ui/components/accordion';
import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { MDXComponents } from 'mdx/types';
import * as guide from '@/components/guide/blocks';
import { Diagram } from '@/components/guide/diagram';

/** Every component a guide page may use, without importing it. */
export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    ...guide,
    Accordion,
    AccordionGroup: Accordions,
    Diagram,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
