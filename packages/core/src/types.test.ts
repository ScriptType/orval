import { describe, it, expectTypeOf } from 'vitest';
import type { StrictSchemaObject, NonBooleanSchemaObject } from './types';
import { getSchemaExtension } from './types';

describe('StrictSchemaObject', () => {
  it('should have typed .type property (not any)', () => {
    expectTypeOf<StrictSchemaObject['type']>().not.toBeAny();
  });

  it('should have typed .properties property (not any)', () => {
    expectTypeOf<StrictSchemaObject['properties']>().not.toBeAny();
  });

  it('should have typed .allOf property (not any)', () => {
    expectTypeOf<StrictSchemaObject['allOf']>().not.toBeAny();
  });

  it('should have typed .enum property (not any)', () => {
    expectTypeOf<StrictSchemaObject['enum']>().not.toBeAny();
  });

  it('should have typed .required property (not any)', () => {
    expectTypeOf<StrictSchemaObject['required']>().not.toBeAny();
  });

  it('should be assignable from NonBooleanSchemaObject', () => {
    expectTypeOf<NonBooleanSchemaObject>().toMatchTypeOf<StrictSchemaObject>();
  });

  it('should be assignable to NonBooleanSchemaObject', () => {
    expectTypeOf<StrictSchemaObject>().toMatchTypeOf<NonBooleanSchemaObject>();
  });
});

describe('getSchemaExtension', () => {
  it('should return T | undefined', () => {
    const schema = {} as StrictSchemaObject;
    const result = getSchemaExtension<string[]>(schema, 'x-enumNames');
    expectTypeOf(result).toEqualTypeOf<string[] | undefined>();
  });

  it('should accept undefined schema', () => {
    const result = getSchemaExtension<string>(undefined, 'x-enumNames');
    expectTypeOf(result).toEqualTypeOf<string | undefined>();
  });

  it('should default generic to unknown', () => {
    const schema = {} as StrictSchemaObject;
    const result = getSchemaExtension(schema, 'x-custom');
    expectTypeOf(result).toEqualTypeOf<unknown | undefined>();
  });

  it('should accept NonBooleanSchemaObject without cast', () => {
    const nb = {} as NonBooleanSchemaObject;
    // This must compile without error — NonBooleanSchemaObject is assignable to StrictSchemaObject
    const result = getSchemaExtension<string[]>(nb, 'x-enumNames');
    expectTypeOf(result).toEqualTypeOf<string[] | undefined>();
  });
});
