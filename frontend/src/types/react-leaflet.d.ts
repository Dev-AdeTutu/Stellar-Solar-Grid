declare module 'react-leaflet' {
  import React from 'react';
  export const MapContainer: React.ComponentType<any>;
  export const TileLayer: React.ComponentType<any>;
  export const CircleMarker: React.ComponentType<any>;
  export const Popup: React.ComponentType<any>;
  export const useMap: () => any;
}

declare module 'leaflet' {
  export type LatLngExpression = [number, number] | any;
  export const divIcon: any;
}
