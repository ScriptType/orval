import { describe, expect, it } from 'vitest';

import type { OpenApiSchemaObject } from '../types';
import { createContextSpec } from '../__tests__/test-factories';
import { combineSchemas } from './combine';

const petSchema: OpenApiSchemaObject = {
  type: 'object',
  required: ['id', 'name', 'petType'],
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' },
    petType: { type: 'string' },
  },
};

const context = createContextSpec({
  target: 'spec',
  spec: {
    components: {
      schemas: {
        Pet: petSchema,
        Base: {
          type: 'object',
          properties: {
            name: { type: 'string' },
          },
        },
      },
    },
  },
  output: {
    override: {
      enumGenerationType: 'const',
      components: {
        schemas: { itemSuffix: 'Item' },
        requestBodies: { suffix: 'RequestBody' },
      },
    },
  },
});

describe('combineSchemas (allOf required handling)', () => {
  it('does not add Required<Pick> when required properties are defined on parent', () => {
    const schema: OpenApiSchemaObject = {
      type: 'object',
      required: ['name', 'sound'],
      properties: {
        name: { type: 'string' },
        sound: { type: 'string' },
      },
      allOf: [{ $ref: '#/components/schemas/Pet' }],
    };

    const result = combineSchemas({
      schema,
      name: 'Dog',
      separator: 'allOf',
      context,
      nullable: '',
    });

    expect(result.value).toContain('Pet &');
    expect(result.value).not.toContain('Required<Pick');
  });

  it('keeps Required<Pick> when parent requires properties defined only in subschemas', () => {
    const schema: OpenApiSchemaObject = {
      type: 'object',
      required: ['name'],
      allOf: [{ $ref: '#/components/schemas/Base' }],
    };

    const result = combineSchemas({
      schema,
      name: 'PetWrapper',
      separator: 'allOf',
      context,
      nullable: '',
    });

    expect(result.value).toContain('Required<Pick');
  });

  it('normalizes inline object in allOf to match parent object form', () => {
    const variantA: OpenApiSchemaObject = {
      allOf: [
        { $ref: '#/components/schemas/Pet' },
        {
          type: 'object',
          required: ['name', 'sound'],
          properties: {
            name: { type: 'string' },
            sound: { type: 'string' },
          },
        },
      ],
    };

    const variantB: OpenApiSchemaObject = {
      type: 'object',
      required: ['name', 'sound'],
      properties: {
        name: { type: 'string' },
        sound: { type: 'string' },
      },
      allOf: [{ $ref: '#/components/schemas/Pet' }],
    };

    const resultA = combineSchemas({
      schema: variantA,
      name: 'DogA',
      separator: 'allOf',
      context,
      nullable: '',
    });

    const resultB = combineSchemas({
      schema: variantB,
      name: 'DogB',
      separator: 'allOf',
      context,
      nullable: '',
    });

    expect(resultA.value).toBe(resultB.value);
  });
});
