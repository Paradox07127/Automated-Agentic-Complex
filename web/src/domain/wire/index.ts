// agentd wire shapes: keys, units and nullability exactly as the backend sends them. Only domain/adapt turns them into
// domain objects. Times are epoch seconds (float) unless a field is typed ISO (`string`, with offset) or has a unit suffix.
export type * from './work';
export type * from './context';
export type * from './system';
