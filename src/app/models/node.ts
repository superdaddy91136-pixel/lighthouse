import { MediaType } from "./mediaType";
import { NodeType } from "./nodeType";
import { ViewMode } from "./viewMode";

export class Node {
  readonly id: number;
  readonly name: string;
  readonly type: NodeType;
  readonly scrollPosition: number;
  query?: string;
  page?: number;
  fromViewType?: ViewMode;
  fromMediaTypes?: MediaType[];

  constructor(
    id: number,
    name: string,
    type: NodeType,
    query?: string,
    fromViewType?: ViewMode,
    fromMediaTypes?: MediaType[]
  ) {
    this.id = id;
    this.name = name;
    this.type = type;
    this.query = query;
    this.scrollPosition = window.scrollY;
    this.fromViewType = fromViewType;
    this.fromMediaTypes = fromMediaTypes;
  }

  toString(): string {
    return `Viewing: ${this.name}`;
  }
}
