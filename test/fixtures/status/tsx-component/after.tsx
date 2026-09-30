export const Crust = ({ size, golden }: { size: number; golden: boolean }) => {
  return <div className="crust">{size}</div>;
};

export function Filling({ flavor }: { flavor: string }) {
  return <strong>{flavor}</strong>;
}

export const Topping = () => <em>seeds</em>;

export function Glaze() {
  return <i>shine</i>;
}
