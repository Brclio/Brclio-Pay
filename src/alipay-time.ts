/** The V2 gateway uses China Standard Time regardless of the runtime timezone. */
export function alipayTimestamp(milliseconds:number):string {
  return new Date(milliseconds+8*60*60*1000).toISOString().slice(0,19).replace('T',' ');
}

/** Parse a signed provider payment date; absence preserves older response support. */
export function alipayPaidAt(value:unknown):string|undefined {
  if(value===undefined)return undefined;
  if(typeof value!=='string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value))throw new TypeError('Invalid Alipay payment time');
  const date=new Date(`${value.replace(' ','T')}+08:00`);
  // Date parsing can normalize impossible dates such as February 30. Require
  // the original Shanghai date to round-trip rather than change its day.
  if(!Number.isFinite(date.getTime()) || alipayTimestamp(date.getTime())!==value)throw new TypeError('Invalid Alipay payment time');
  return date.toISOString();
}
