export const Crust = ({ size }: { size: number }) => {
  return <div className="crust">{size}</div>;
};

export function Filling({ flavor }: { flavor: string }) {
  return <span>{flavor}</span>;
}

export const Topping = () => <em>seeds</em>;
