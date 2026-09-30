const addFee = (total: number, fee = 1): number => total + fee;

export const describeOrder = async <T,>(order: T) => {
  return String(order);
};

let legacyFormat = function (value: unknown) {
  return `${String(value)}`;
};

const identity = (value: string) => value;

const plainRate = 0.2;

const trimLabel: Formatter = (text) => text.trim();

var shout = (text: string) => text.toUpperCase(), whisper = (text: string) => text.toLowerCase();
