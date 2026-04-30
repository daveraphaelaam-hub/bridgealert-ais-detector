'use strict';

/**
 * The 5 target Miami drawbridges.
 *
 * Coordinates verified against Waterway Guide, USGS, and Federal Register
 * sources (April 2026). All in decimal degrees WGS84.
 *
 * Spec coordinates were wrong for 4 of 5 bridges — corrected values used here.
 */
const BRIDGES = [
  {
    id: 'venetian_east',
    name: 'Venetian Causeway East',
    fl511Name: 'AIS DETECTED',
    county: 'Miami-Dade',
    lat: 25.7912,
    lon: -80.1520,
    waterway: 'Biscayne Bay',
  },
  {
    id: 'venetian_west',
    name: 'Venetian Causeway West',
    fl511Name: 'AIS DETECTED',
    county: 'Miami-Dade',
    lat: 25.7899,
    lon: -80.1815,
    waterway: 'Biscayne Bay (ICW)',
  },
  {
    id: 'south_miami_ave',
    name: 'South Miami Avenue Bridge',
    fl511Name: 'AIS DETECTED',
    county: 'Miami-Dade',
    lat: 25.7697,
    lon: -80.1935,
    waterway: 'Miami River (mile 0.3)',
  },
  {
    id: 'nw_17th_ave',
    name: 'NW 17th Avenue Bridge',
    fl511Name: 'AIS DETECTED',
    county: 'Miami-Dade',
    lat: 25.7855,
    lon: -80.2230,
    waterway: 'Miami River (mile 2.8)',
  },
  {
    id: 'nw_22nd_ave',
    name: 'NW 22nd Avenue Bridge',
    fl511Name: 'AIS DETECTED',
    county: 'Miami-Dade',
    lat: 25.7887,
    lon: -80.2314,
    waterway: 'Miami River (mile 3.2)',
  },
];

module.exports = BRIDGES;
