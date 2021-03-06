import {
  graphql,
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLList,
  GraphQLType,
  GraphQLResolveInfo,
  getNullableType,
  getNamedType,
  GraphQLFieldResolver,
  GraphQLNullableType,
  isSchema,
  isObjectType,
  isInterfaceType,
  isListType,
  isEnumType,
  isAbstractType,
  GraphQLInterfaceType,
  GraphQLUnionType,
  GraphQLTypeResolver,
} from 'graphql';

import { buildSchemaFromTypeDefinitions } from '@graphql-tools/schema';
import { IMocks, IMockServer, IMockFn, IMockOptions, IMockTypeFn } from './types';
import { ITypeDefinitions, mapSchema, MapperKind } from '@graphql-tools/utils';

/**
 * A convenience wrapper on top of addMocksToSchema. It adds your mock resolvers
 * to your schema and returns a client that will correctly execute your query with
 * variables. Note: when executing queries from the returned server, context and
 * root will both equal `{}`.
 * @param schema The schema to which to add mocks. This can also be a set of type
 * definitions instead.
 * @param mocks The mocks to add to the schema.
 * @param preserveResolvers Set to `true` to prevent existing resolvers from being
 * overwritten to provide mock data. This can be used to mock some parts of the
 * server and not others.
 */
export function mockServer(
  schema: GraphQLSchema | ITypeDefinitions,
  mocks: IMocks,
  preserveResolvers = false
): IMockServer {
  let mySchema: GraphQLSchema;
  if (!isSchema(schema)) {
    // TODO: provide useful error messages here if this fails
    mySchema = buildSchemaFromTypeDefinitions(schema);
  } else {
    mySchema = schema;
  }

  mySchema = addMocksToSchema({ schema: mySchema, mocks, preserveResolvers });

  return { query: (query, vars) => graphql(mySchema, query, {}, {}, vars) };
}

function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    // eslint-disable-next-line eqeqeq
    const v = c == 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

const defaultMockMap: Map<string, IMockFn> = new Map();
defaultMockMap.set('Int', () => Math.round(Math.random() * 200) - 100);
defaultMockMap.set('Float', () => Math.random() * 200 - 100);
defaultMockMap.set('String', () => 'Hello World');
defaultMockMap.set('Boolean', () => Math.random() > 0.5);
defaultMockMap.set('ID', () => uuidv4());

// TODO allow providing a seed such that lengths of list could be deterministic
// this could be done by using casual to get a random list length if the casual
// object is global.

/**
 * Given an instance of GraphQLSchema and a mock object, returns a new schema
 * that can return mock data for any valid query that is sent to the server.
 * @param options Options object
 */
export function addMocksToSchema({ schema, mocks = {}, preserveResolvers = false }: IMockOptions): GraphQLSchema {
  if (!schema) {
    throw new Error('Must provide schema to mock');
  }
  if (!isSchema(schema)) {
    throw new Error('Value at "schema" must be of type GraphQLSchema');
  }
  if (!isObject(mocks)) {
    throw new Error('mocks must be of type Object');
  }

  // use Map internally, because that API is nicer.
  const mockFunctionMap: Map<string, IMockFn> = new Map();
  Object.keys(mocks).forEach(typeName => {
    mockFunctionMap.set(typeName, mocks[typeName]);
  });

  mockFunctionMap.forEach((mockFunction, mockTypeName) => {
    if (typeof mockFunction !== 'function') {
      throw new Error(`mockFunctionMap[${mockTypeName}] must be a function`);
    }
  });

  const mockType = function (
    type: GraphQLType,
    _typeName?: string,
    fieldName?: string
  ): GraphQLFieldResolver<any, any> {
    // order of precendence for mocking:
    // 1. if the object passed in already has fieldName, just use that
    // --> if it's a function, that becomes your resolver
    // --> if it's a value, the mock resolver will return that
    // 2. if the nullableType is a list, recurse
    // 2. if there's a mock defined for this typeName, that will be used
    // 3. if there's no mock defined, use the default mocks for this type
    return (root: any, args: Record<string, any>, context: any, info: GraphQLResolveInfo): any => {
      // nullability doesn't matter for the purpose of mocking.
      const fieldType = getNullableType(type) as GraphQLNullableType;
      const namedFieldType = getNamedType(fieldType);

      if (fieldName && root && typeof root[fieldName] !== 'undefined') {
        let result: any;

        // if we're here, the field is already defined
        if (typeof root[fieldName] === 'function') {
          result = root[fieldName](args, context, info);
          if (isMockList(result)) {
            result = result.mock(root, args, context, info, fieldType as GraphQLList<any>, mockType);
          }
        } else {
          result = root[fieldName];
        }

        // Now we merge the result with the default mock for this type.
        // This allows overriding defaults while writing very little code.
        if (mockFunctionMap.has(namedFieldType.name)) {
          const mock = mockFunctionMap.get(namedFieldType.name);

          result = mergeMocks(mock.bind(null, root, args, context, info), result);
        }
        return result;
      }

      if (isListType(fieldType)) {
        return [
          mockType(fieldType.ofType)(root, args, context, info),
          mockType(fieldType.ofType)(root, args, context, info),
        ];
      }
      if (mockFunctionMap.has(fieldType.name) && !isAbstractType(fieldType)) {
        // the object passed doesn't have this field, so we apply the default mock
        const mock = mockFunctionMap.get(fieldType.name);
        return mock(root, args, context, info);
      }
      if (isObjectType(fieldType)) {
        // objects don't return actual data, we only need to mock scalars!
        return {};
      }
      // if a mock function is provided for unionType or interfaceType, execute it to resolve the concrete type
      // otherwise randomly pick a type from all implementation types
      if (isAbstractType(fieldType)) {
        let implementationType;
        let interfaceMockObj: any = {};
        if (mockFunctionMap.has(fieldType.name)) {
          const mock = mockFunctionMap.get(fieldType.name);
          interfaceMockObj = mock(root, args, context, info);
          if (!interfaceMockObj || !interfaceMockObj.__typename) {
            return Error(`Please return a __typename in "${fieldType.name}"`);
          }
          implementationType = schema.getType(interfaceMockObj.__typename);
        } else {
          const possibleTypes = schema.getPossibleTypes(fieldType);
          implementationType = getRandomElement(possibleTypes);
        }
        return {
          __typename: implementationType,
          ...interfaceMockObj,
          ...mockType(implementationType)(root, args, context, info),
        };
      }

      if (isEnumType(fieldType)) {
        return getRandomElement(fieldType.getValues()).value;
      }

      if (defaultMockMap.has(fieldType.name)) {
        const defaultMock = defaultMockMap.get(fieldType.name);
        return defaultMock(root, args, context, info);
      }

      // if we get to here, we don't have a value, and we don't have a mock for this type,
      // we could return undefined, but that would be hard to debug, so we throw instead.
      // however, we returning it instead of throwing it, so preserveResolvers can handle the failures.
      return Error(`No mock defined for type "${fieldType.name}"`);
    };
  };

  return mapSchema(schema, {
    [MapperKind.ABSTRACT_TYPE]: type => {
      const oldResolveType = type.resolveType;
      if (preserveResolvers && oldResolveType != null && oldResolveType.length) {
        return;
      }

      // the default `resolveType` always returns null. We add a fallback
      // resolution that works with how unions and interface are mocked
      const resolveType: GraphQLTypeResolver<any, any> = (data, _context, info: GraphQLResolveInfo) =>
        info.schema.getType(data.__typename) as GraphQLObjectType;

      if (isInterfaceType(type)) {
        return new GraphQLInterfaceType({
          ...type.toConfig(),
          resolveType,
        });
      } else {
        return new GraphQLUnionType({
          ...type.toConfig(),
          resolveType,
        });
      }
    },
    [MapperKind.OBJECT_FIELD]: (fieldConfig, fieldName, typeName) => {
      const fieldType = fieldConfig.type;
      const fieldResolver = fieldConfig.resolve;
      const newFieldConfig = {
        ...fieldConfig,
      };

      let mockResolver: GraphQLFieldResolver<any, any> = mockType(fieldType, typeName, fieldName);

      // we have to handle the root mutation and root query types differently,
      // because no resolver is called at the root.
      const queryType = schema.getQueryType();
      const isOnQueryType = queryType != null && queryType.name === typeName;

      const mutationType = schema.getMutationType();
      const isOnMutationType = mutationType != null && mutationType.name === typeName;

      const subscriptionType = schema.getSubscriptionType();
      const isOnSubscriptionType = subscriptionType != null && subscriptionType.name === typeName;

      if (isOnQueryType || isOnMutationType || isOnSubscriptionType) {
        if (mockFunctionMap.has(typeName)) {
          const rootMock = mockFunctionMap.get(typeName);
          // XXX: BUG in here, need to provide proper signature for rootMock.
          if (typeof rootMock(undefined, {}, {}, {} as any)[fieldName] === 'function') {
            mockResolver = (root: any, args: Record<string, any>, context: any, info: GraphQLResolveInfo) => {
              const updatedRoot = root ?? {}; // TODO: should we clone instead?
              updatedRoot[fieldName] = rootMock(root, args, context, info)[fieldName];
              // XXX this is a bit of a hack to still use mockType, which
              // lets you mock lists etc. as well
              // otherwise we could just set field.resolve to rootMock()[fieldName]
              // it's like pretending there was a resolver that ran before
              // the root resolver.
              const result = mockType(fieldConfig.type, typeName, fieldName)(updatedRoot, args, context, info);
              return result;
            };
          }
        }
      }
      if (!preserveResolvers || !fieldResolver) {
        newFieldConfig.resolve = mockResolver;
      } else {
        const oldResolver = fieldResolver;
        newFieldConfig.resolve = (rootObject: any, args: Record<string, any>, context: any, info: GraphQLResolveInfo) =>
          Promise.all([
            mockResolver(rootObject, args, context, info),
            oldResolver(rootObject, args, context, info),
          ]).then(values => {
            const [mockedValue, resolvedValue] = values;

            // In case we couldn't mock
            if (mockedValue instanceof Error) {
              // only if value was not resolved, populate the error.
              if (undefined === resolvedValue) {
                throw mockedValue;
              }
              return resolvedValue;
            }

            if (resolvedValue instanceof Date && mockedValue instanceof Date) {
              return undefined !== resolvedValue ? resolvedValue : mockedValue;
            }

            if (isObject(mockedValue) && isObject(resolvedValue)) {
              // Object.assign() won't do here, as we need to all properties, including
              // the non-enumerable ones and defined using Object.defineProperty
              const emptyObject = Object.create(Object.getPrototypeOf(resolvedValue));
              return copyOwnProps(emptyObject, resolvedValue, mockedValue);
            }
            return undefined !== resolvedValue ? resolvedValue : mockedValue;
          });
      }

      const fieldSubscriber = fieldConfig.subscribe;
      const mockSubscriber = (..._args: any[]) => ({
        [Symbol.asyncIterator]() {
          return {
            async next() {
              return {
                done: true,
                value: {},
              };
            },
          };
        },
      });

      if (!preserveResolvers || !fieldSubscriber) {
        newFieldConfig.subscribe = mockSubscriber;
      } else {
        newFieldConfig.subscribe = async (
          rootObject: any,
          args: Record<string, any>,
          context: any,
          info: GraphQLResolveInfo
        ) => {
          const [mockAsyncIterable, oldAsyncIterable] = await Promise.all([
            mockSubscriber(rootObject, args, context, info),
            fieldSubscriber(rootObject, args, context, info),
          ]);
          return oldAsyncIterable || mockAsyncIterable;
        };
      }

      return newFieldConfig;
    },
  });
}

function isObject(thing: any) {
  return thing === Object(thing) && !Array.isArray(thing);
}

// returns a random element from that ary
function getRandomElement(ary: ReadonlyArray<any>) {
  const sample = Math.floor(Math.random() * ary.length);
  return ary[sample];
}

function mergeObjects(a: Record<string, any>, b: Record<string, any>) {
  return Object.assign(a, b);
}

function copyOwnPropsIfNotPresent(target: Record<string, any>, source: Record<string, any>) {
  Object.getOwnPropertyNames(source).forEach(prop => {
    if (!Object.getOwnPropertyDescriptor(target, prop)) {
      const propertyDescriptor = Object.getOwnPropertyDescriptor(source, prop);
      Object.defineProperty(target, prop, propertyDescriptor == null ? {} : propertyDescriptor);
    }
  });
}

function copyOwnProps(target: Record<string, any>, ...sources: Array<Record<string, any>>) {
  sources.forEach(source => {
    let chain = source;
    while (chain != null) {
      copyOwnPropsIfNotPresent(target, chain);
      chain = Object.getPrototypeOf(chain);
    }
  });
  return target;
}

// takes either an object or a (possibly nested) array
// and completes the customMock object with any fields
// defined on genericMock
// only merges objects or arrays. Scalars are returned as is
function mergeMocks(genericMockFunction: () => any, customMock: any): any {
  if (Array.isArray(customMock)) {
    return customMock.map((el: any) => mergeMocks(genericMockFunction, el));
  }
  if (customMock instanceof Promise) {
    return customMock.then((res: any) => mergeObjects(genericMockFunction(), res));
  }
  if (isObject(customMock)) {
    return mergeObjects(genericMockFunction(), customMock);
  }
  return customMock;
}

/**
 * @internal
 */
export function isMockList(obj: any): obj is MockList {
  if (typeof obj?.len === 'number' || (Array.isArray(obj?.len) && typeof obj?.len[0] === 'number')) {
    if (typeof obj.wrappedFunction === 'undefined' || typeof obj.wrappedFunction === 'function') {
      return true;
    }
  }

  return false;
}

/**
 * This is an object you can return from your mock resolvers which calls the
 * provided `mockFunction` once for each list item.
 */
export class MockList {
  private readonly len: number | Array<number>;
  private readonly wrappedFunction: GraphQLFieldResolver<any, any> | undefined;

  /**
   * @param length Either the exact length of items to return or an inclusive
   * range of possible lengths.
   * @param mockFunction The function to call for each item in the list to
   * resolve it. It can return another MockList or a value.
   */
  constructor(length: number | Array<number>, mockFunction?: GraphQLFieldResolver<any, any>) {
    this.len = length;
    if (typeof mockFunction !== 'undefined') {
      if (typeof mockFunction !== 'function') {
        throw new Error('Second argument to MockList must be a function or undefined');
      }
      this.wrappedFunction = mockFunction;
    }
  }

  /**
   * @internal
   */
  public mock(
    root: any,
    args: Record<string, any>,
    context: any,
    info: GraphQLResolveInfo,
    fieldType: GraphQLList<any>,
    mockTypeFunc: IMockTypeFn
  ) {
    let arr: Array<any>;
    if (Array.isArray(this.len)) {
      arr = new Array(this.randint(this.len[0], this.len[1]));
    } else {
      arr = new Array(this.len);
    }

    for (let i = 0; i < arr.length; i++) {
      if (typeof this.wrappedFunction === 'function') {
        const res = this.wrappedFunction(root, args, context, info);
        if (isMockList(res)) {
          const nullableType = getNullableType(fieldType.ofType) as GraphQLList<any>;
          arr[i] = res.mock(root, args, context, info, nullableType, mockTypeFunc);
        } else {
          arr[i] = res;
        }
      } else {
        arr[i] = mockTypeFunc(fieldType.ofType)(root, args, context, info);
      }
    }
    return arr;
  }

  private randint(low: number, high: number): number {
    return Math.floor(Math.random() * (high - low + 1) + low);
  }
}
