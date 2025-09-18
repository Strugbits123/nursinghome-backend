// types/google.ts

export interface GooglePlacePhoto {
  photo_reference: string;
}

export interface GooglePlaceCandidate {
  geometry?: {
    location?: {
      lat: number;
      lng: number;
    };
  };
  photos?: GooglePlacePhoto[];
  place_id?: string;
}

export interface GoogleFindPlaceResponse {
  candidates: GooglePlaceCandidate[];
  status: string;
}

export interface PlaceReview {
  author_name: string;
  text: string;
  rating: number;
}

export interface PlaceDetailss {
  result?: {
    geometry?: {
      location?: {
        lat: number;
        lng: number;
      };
    };
    reviews?: PlaceReview[];
    photos?: GooglePlacePhoto[];
  };
  status: string;
}
