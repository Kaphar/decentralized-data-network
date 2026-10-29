/// <reference types="vite/client" />
/// <reference types="node" />

declare global {
  namespace JSX {
    interface ElementChildrenAttribute {
      key: string | undefined;
      children: {};
    }
  }
}

export {};
