export type DistrictReference = {
  district: string;
  latitude: number;
  longitude: number;
  reference: 'boundary-centre' | 'district-headquarters';
};

// Coordinates were retrieved from OpenStreetMap Nominatim on 2026-10-18.
// Most are district administrative-boundary reference points; the listed city points
// are verified district headquarters where an OSM district boundary centroid was not returned.
export const KARNATAKA_DISTRICT_REFERENCES: DistrictReference[] = [
  { district: 'Bagalkote', latitude: 16.2903648, longitude: 75.5915819, reference: 'boundary-centre' },
  { district: 'Ballari', latitude: 15.3483166, longitude: 76.8054883, reference: 'boundary-centre' },
  { district: 'Belagavi', latitude: 16.1587846, longitude: 74.888862, reference: 'boundary-centre' },
  { district: 'Bengaluru Rural', latitude: 13.2483502, longitude: 77.7134377, reference: 'district-headquarters' },
  { district: 'Bengaluru Urban', latitude: 12.9461554, longitude: 77.5503844, reference: 'boundary-centre' },
  { district: 'Bengaluru South', latitude: 12.720006, longitude: 77.3184199, reference: 'boundary-centre' },
  { district: 'Bidar', latitude: 18.0207297, longitude: 77.2487204, reference: 'boundary-centre' },
  { district: 'Chamarajanagar', latitude: 11.9544201, longitude: 77.1069086, reference: 'boundary-centre' },
  { district: 'Chikkaballapura', latitude: 13.5897941, longitude: 77.778793, reference: 'boundary-centre' },
  { district: 'Chikkamagaluru', latitude: 13.4058699, longitude: 75.638758, reference: 'boundary-centre' },
  { district: 'Chitradurga', latitude: 14.3049174, longitude: 76.5296667, reference: 'boundary-centre' },
  { district: 'Dakshina Kannada', latitude: 12.8226434, longitude: 75.2265036, reference: 'boundary-centre' },
  { district: 'Davanagere', latitude: 14.2558835, longitude: 75.8303421, reference: 'boundary-centre' },
  { district: 'Dharwad', latitude: 15.3707296, longitude: 75.1332867, reference: 'boundary-centre' },
  { district: 'Gadag', latitude: 15.416692, longitude: 75.6815801, reference: 'boundary-centre' },
  { district: 'Hassan', latitude: 13.0301852, longitude: 76.1744968, reference: 'boundary-centre' },
  { district: 'Haveri', latitude: 14.7180268, longitude: 75.3656423, reference: 'boundary-centre' },
  { district: 'Kalaburagi', latitude: 17.2408957, longitude: 76.7697439, reference: 'boundary-centre' },
  { district: 'Kodagu', latitude: 12.3827332, longitude: 75.6640715, reference: 'boundary-centre' },
  { district: 'Kolar', latitude: 13.1805066, longitude: 78.2669329, reference: 'boundary-centre' },
  { district: 'Koppal', latitude: 15.5748238, longitude: 76.3118494, reference: 'boundary-centre' },
  { district: 'Mandya', latitude: 12.6368939, longitude: 76.7275477, reference: 'boundary-centre' },
  { district: 'Mysuru', latitude: 12.3041464, longitude: 76.6529521, reference: 'district-headquarters' },
  { district: 'Raichur', latitude: 16.0547194, longitude: 76.9003647, reference: 'boundary-centre' },
  { district: 'Shivamogga', latitude: 13.9326093, longitude: 75.574978, reference: 'district-headquarters' },
  { district: 'Tumakuru', latitude: 13.4192512, longitude: 76.8810004, reference: 'boundary-centre' },
  { district: 'Udupi', latitude: 13.5269784, longitude: 74.8731879, reference: 'boundary-centre' },
  { district: 'Uttara Kannada', latitude: 14.7253795, longitude: 74.6403389, reference: 'boundary-centre' },
  { district: 'Vijayanagara', latitude: 14.9428567, longitude: 76.0448007, reference: 'boundary-centre' },
  { district: 'Vijayapura', latitude: 16.814415, longitude: 75.8933856, reference: 'boundary-centre' },
  { district: 'Yadgir', latitude: 16.5744123, longitude: 76.9254434, reference: 'boundary-centre' },
];

const districtAliases = new Map([
  ['bangalore rural', 'Bengaluru Rural'],
  ['bengaluru north', 'Bengaluru Rural'],
  ['bangalore south', 'Bengaluru South'],
  ['ramanagara', 'Bengaluru South'],
  ['bangalore urban', 'Bengaluru Urban'],
  ['mysore', 'Mysuru'],
  ['shimoga', 'Shivamogga'],
  ['bagalkot', 'Bagalkote'],
  ['belgaum', 'Belagavi'],
  ['gulbarga', 'Kalaburagi'],
]);

export function normalizeDistrict(value: string): string {
  const normalized = value.normalize('NFKC').trim().toLocaleLowerCase('en-IN').replace(/\s+/g, ' ');
  return districtAliases.get(normalized) ?? KARNATAKA_DISTRICT_REFERENCES.find((item) => item.district.toLocaleLowerCase('en-IN') === normalized)?.district ?? value.trim();
}

export function getDistrictReference(value: string): DistrictReference | null {
  const district = normalizeDistrict(value);
  return KARNATAKA_DISTRICT_REFERENCES.find((item) => item.district === district) ?? null;
}

export function haversineKm(from: DistrictReference, to: DistrictReference): number {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const latitudeDelta = radians(to.latitude - from.latitude);
  const longitudeDelta = radians(to.longitude - from.longitude);
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(from.latitude)) * Math.cos(radians(to.latitude)) * Math.sin(longitudeDelta / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export const MARKET_DISTANCE_SOURCE = 'OpenStreetMap district boundaries and district-headquarters reference points (Nominatim, checked 2026-10-18). Distances are straight-line district-level estimates, not market-to-market distances.';
