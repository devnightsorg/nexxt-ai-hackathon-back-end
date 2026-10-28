import { parseToolArguments } from './tool-arguments';

describe('parseToolArguments', () => {
  it('parses plain JSON; empty → {}', () => {
    expect(parseToolArguments('{"amount": 5000}')).toEqual({ amount: 5000 });
    expect(parseToolArguments(' {} ')).toEqual({});
    expect(parseToolArguments('')).toEqual({});
    expect(parseToolArguments(undefined)).toEqual({});
  });

  it('salvages arguments whose opening was streamed repeatedly', () => {
    expect(parseToolArguments('{}{}{}{}')).toEqual({});
    expect(parseToolArguments('{"slug": "{"slug": "{"slug": "depozit-termen-lei"}')).toEqual({ slug: 'depozit-termen-lei' });
  });

  it('never mistakes a nested or truncated payload for the arguments', () => {
    expect(parseToolArguments('{"fromAccountId": "a", "meta": {"amount": 5}')).toBeUndefined();
    expect(parseToolArguments('not json')).toBeUndefined();
    expect(parseToolArguments('{"a": [1, 2]')).toBeUndefined();
    expect(parseToolArguments('x[1]')).toBeUndefined();
  });
});
