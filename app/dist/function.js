"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PersonToAlbum = void 0;
const tslib_1 = require("tslib");
const sdk_1 = require("@immich/sdk");
const path_1 = tslib_1.__importDefault(require("path"));
/** Maximum number of assets in one search page, and in one add-to-album request */
const PAGE_SIZE = 1000;
class PersonToAlbum {
    constructor() {
        this.initConfig();
    }
    /**
     * Read the config.json file or parse the CONFIG env value to get the configuration
     */
    initConfig() {
        try {
            if (process.env.CONFIG) {
                // Attempt to parse docker-compose config string into JSON (if specified)
                this.config = JSON.parse(process.env.CONFIG);
            }
            else {
                const configJson = require(path_1.default.resolve('../data/config.json'));
                if (typeof configJson === 'object')
                    this.config = configJson;
            }
        }
        catch (e) {
            console.log(e);
            console.log('Unable to parse config file.');
        }
    }
    /**
     * Apply the defaults to a config link and check its fields. Throws if the link is invalid.
     */
    normaliseLink(config) {
        var _a, _b, _c;
        const personIds = (_a = config.personIds) !== null && _a !== void 0 ? _a : (config.personId ? [config.personId] : []);
        // The logic makes no difference for one person, so it is only necessary for two or more
        const logic = (_b = config.logic) !== null && _b !== void 0 ? _b : (personIds.length === 1 ? 'OR' : undefined);
        const excludePersonIds = (_c = config.excludePersonIds) !== null && _c !== void 0 ? _c : [];
        if (!config.albumId)
            throw new Error('Invalid link: albumId is missing');
        if (!personIds.length)
            throw new Error('Invalid link: personIds is empty');
        if (logic !== 'AND' && logic !== 'OR')
            throw new Error(`Invalid link: set logic to AND or OR, not ${logic}`);
        const overlap = personIds.filter(id => excludePersonIds.includes(id));
        if (overlap.length)
            throw new Error(`Invalid link: ${overlap.join(', ')} is in personIds and excludePersonIds`);
        return {
            description: config.description,
            albumId: config.albumId,
            personIds,
            logic,
            excludePersonIds,
            noOtherPeople: config.noOtherPeople === true,
            removeUnmatched: config.removeUnmatched === true
        };
    }
    processLink(config) {
        return tslib_1.__awaiter(this, void 0, void 0, function* () {
            if (config.description)
                console.log(`=== ${config.description} ===`);
            const link = this.normaliseLink(config);
            console.log(`Adding ${link.logic} of people ${link.personIds.join(', ')} to album ${link.albumId}`);
            const personIds = link.logic === 'AND' ? { all: link.personIds } : { any: link.personIds };
            if (link.excludePersonIds.length)
                personIds.none = link.excludePersonIds;
            const assets = yield this.searchAll({ personIds, albumIds: { none: [link.albumId] } }, link.noOtherPeople);
            const ids = this.applyNoOtherPeople(link, assets).map(x => x.id);
            for (let i = 0; i < ids.length; i += PAGE_SIZE) {
                yield (0, sdk_1.addAssetsToAlbum)({
                    id: link.albumId,
                    bulkIdsDto: { ids: ids.slice(i, i + PAGE_SIZE) }
                });
            }
            console.log(` - Added ${ids.length} assets`);
            console.log();
        });
    }
    /**
     * Get every asset that matches a search filter.
     *
     * The search cursor is an offset. A change to an album changes the results of a search that
     * filters on that album, so this collects every page before the caller adds or removes assets.
     */
    searchAll(filter_1) {
        return tslib_1.__awaiter(this, arguments, void 0, function* (filter, withPeople = false) {
            var _a;
            const assets = [];
            let cursor;
            do {
                const res = yield (0, sdk_1.searchAssets)({
                    metadataSearchDto: { filter, withPeople: withPeople || undefined, size: PAGE_SIZE, cursor }
                });
                assets.push(...res.assets.items);
                cursor = (_a = res.assets.nextCursor) !== null && _a !== void 0 ? _a : undefined;
            } while (cursor);
            return assets;
        });
    }
    /**
     * Remove the assets that match none of the links of an album. Only the albums that have
     * a link with `removeUnmatched` are processed.
     *
     * @param configs - All the links of one user
     */
    removeUnmatched(configs) {
        return tslib_1.__awaiter(this, void 0, void 0, function* () {
            const albumIds = new Set(configs.filter(x => x.removeUnmatched === true).map(x => x.albumId));
            if (!albumIds.size)
                return;
            // Other users can add assets to a shared album. Those assets are never removed.
            const userId = (yield (0, sdk_1.getMyUser)()).id;
            for (const albumId of albumIds) {
                console.log(`Removing unmatched assets from album ${albumId}`);
                try {
                    // An invalid link throws here, and the album is then left as it is
                    const links = configs.filter(x => x.albumId === albumId).map(x => this.normaliseLink(x));
                    /*
                    A person ID stops matching when the person is merged or face recognition is reset.
                    The album would then lose all the photos of that person, so do nothing instead.
                    */
                    const missing = yield this.findPeopleWithNoAssets(links.flatMap(x => x.personIds));
                    if (missing.length) {
                        console.log(` - Skipped: no assets found for people ${missing.join(', ')}. Check the person IDs.`);
                        continue;
                    }
                    // An asset is removed only when every link of the album rejects it
                    let ids;
                    for (const link of links) {
                        const assets = yield this.searchAll({ albumIds: { any: [albumId] }, or: this.unmatchedBranches(link) });
                        const unmatched = new Set(assets.filter(x => x.ownerId === userId).map(x => x.id));
                        ids = ids ? ids.filter(id => unmatched.has(id)) : [...unmatched];
                        if (!ids.length)
                            break;
                    }
                    ids = ids !== null && ids !== void 0 ? ids : [];
                    for (let i = 0; i < ids.length; i += PAGE_SIZE) {
                        yield (0, sdk_1.removeAssetFromAlbum)({
                            id: albumId,
                            bulkIdsDto: { ids: ids.slice(i, i + PAGE_SIZE) }
                        });
                    }
                    console.log(` - Removed ${ids.length} assets`);
                }
                catch (e) {
                    console.log(e);
                }
            }
            console.log();
        });
    }
    /**
     * The search branches that find the assets a link rejects. An asset that matches one branch is rejected.
     *
     * `noOtherPeople` has no search filter, so an asset that it rejects is not found here.
     */
    unmatchedBranches(link) {
        const branches = link.logic === 'AND'
            ? link.personIds.map(id => ({ personIds: { none: [id] } }))
            : [{ personIds: { none: link.personIds } }];
        if (link.excludePersonIds.length)
            branches.push({ personIds: { any: link.excludePersonIds } });
        return branches;
    }
    /**
     * Get the person IDs from a list that have no assets in Immich
     */
    findPeopleWithNoAssets(personIds) {
        return tslib_1.__awaiter(this, void 0, void 0, function* () {
            const missing = [];
            for (const id of new Set(personIds)) {
                const res = yield (0, sdk_1.searchAssets)({
                    metadataSearchDto: { filter: { personIds: { any: [id] } }, size: 1 }
                });
                if (!res.assets.items.length)
                    missing.push(id);
            }
            return missing;
        });
    }
    /**
     * When `noOtherPeople` is set, remove the assets that contain a person who is not in `personIds`
     */
    applyNoOtherPeople(link, assets) {
        if (!link.noOtherPeople)
            return assets;
        return assets.filter(asset => {
            var _a;
            // Each search result contains a person from the link, so an empty list means Immich did not send the people
            if (!((_a = asset.people) === null || _a === void 0 ? void 0 : _a.length))
                throw new Error(`Immich returned no people for asset ${asset.id}. Check the API key permissions.`);
            return asset.people.every(person => link.personIds.includes(person.id));
        });
    }
}
exports.PersonToAlbum = PersonToAlbum;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZnVuY3Rpb24uanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvZnVuY3Rpb24udHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7OztBQUNBLHFDQVNvQjtBQUNwQix3REFBdUI7QUFFdkIsbUZBQW1GO0FBQ25GLE1BQU0sU0FBUyxHQUFHLElBQUksQ0FBQTtBQUV0QixNQUFhLGFBQWE7SUFHeEI7UUFDRSxJQUFJLENBQUMsVUFBVSxFQUFFLENBQUE7SUFDbkIsQ0FBQztJQUVEOztPQUVHO0lBQ0gsVUFBVTtRQUNSLElBQUksQ0FBQztZQUNILElBQUksT0FBTyxDQUFDLEdBQUcsQ0FBQyxNQUFNLEVBQUUsQ0FBQztnQkFDdkIseUVBQXlFO2dCQUN6RSxJQUFJLENBQUMsTUFBTSxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxNQUFNLENBQUMsQ0FBQTtZQUM5QyxDQUFDO2lCQUFNLENBQUM7Z0JBQ04sTUFBTSxVQUFVLEdBQUcsT0FBTyxDQUFDLGNBQUksQ0FBQyxPQUFPLENBQUMscUJBQXFCLENBQUMsQ0FBQyxDQUFBO2dCQUMvRCxJQUFJLE9BQU8sVUFBVSxLQUFLLFFBQVE7b0JBQUUsSUFBSSxDQUFDLE1BQU0sR0FBRyxVQUFVLENBQUE7WUFDOUQsQ0FBQztRQUNILENBQUM7UUFBQyxPQUFPLENBQUMsRUFBRSxDQUFDO1lBQ1gsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQTtZQUNkLE9BQU8sQ0FBQyxHQUFHLENBQUMsOEJBQThCLENBQUMsQ0FBQTtRQUM3QyxDQUFDO0lBQ0gsQ0FBQztJQUVEOztPQUVHO0lBQ0gsYUFBYSxDQUFFLE1BQWtCOztRQUMvQixNQUFNLFNBQVMsR0FBRyxNQUFBLE1BQU0sQ0FBQyxTQUFTLG1DQUFJLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFBO1FBQ2hGLHdGQUF3RjtRQUN4RixNQUFNLEtBQUssR0FBRyxNQUFBLE1BQU0sQ0FBQyxLQUFLLG1DQUFJLENBQUMsU0FBUyxDQUFDLE1BQU0sS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDLENBQUE7UUFDekUsTUFBTSxnQkFBZ0IsR0FBRyxNQUFBLE1BQU0sQ0FBQyxnQkFBZ0IsbUNBQUksRUFBRSxDQUFBO1FBRXRELElBQUksQ0FBQyxNQUFNLENBQUMsT0FBTztZQUFFLE1BQU0sSUFBSSxLQUFLLENBQUMsa0NBQWtDLENBQUMsQ0FBQTtRQUN4RSxJQUFJLENBQUMsU0FBUyxDQUFDLE1BQU07WUFBRSxNQUFNLElBQUksS0FBSyxDQUFDLGtDQUFrQyxDQUFDLENBQUE7UUFDMUUsSUFBSSxLQUFLLEtBQUssS0FBSyxJQUFJLEtBQUssS0FBSyxJQUFJO1lBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQyw2Q0FBNkMsS0FBSyxFQUFFLENBQUMsQ0FBQTtRQUM1RyxNQUFNLE9BQU8sR0FBRyxTQUFTLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsZ0JBQWdCLENBQUMsUUFBUSxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUE7UUFDckUsSUFBSSxPQUFPLENBQUMsTUFBTTtZQUFFLE1BQU0sSUFBSSxLQUFLLENBQUMsaUJBQWlCLE9BQU8sQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLHVDQUF1QyxDQUFDLENBQUE7UUFFL0csT0FBTztZQUNMLFdBQVcsRUFBRSxNQUFNLENBQUMsV0FBVztZQUMvQixPQUFPLEVBQUUsTUFBTSxDQUFDLE9BQU87WUFDdkIsU0FBUztZQUNULEtBQUs7WUFDTCxnQkFBZ0I7WUFDaEIsYUFBYSxFQUFFLE1BQU0sQ0FBQyxhQUFhLEtBQUssSUFBSTtZQUM1QyxlQUFlLEVBQUUsTUFBTSxDQUFDLGVBQWUsS0FBSyxJQUFJO1NBQ2pELENBQUE7SUFDSCxDQUFDO0lBRUssV0FBVyxDQUFFLE1BQWtCOztZQUNuQyxJQUFJLE1BQU0sQ0FBQyxXQUFXO2dCQUFFLE9BQU8sQ0FBQyxHQUFHLENBQUMsT0FBTyxNQUFNLENBQUMsV0FBVyxNQUFNLENBQUMsQ0FBQTtZQUNwRSxNQUFNLElBQUksR0FBRyxJQUFJLENBQUMsYUFBYSxDQUFDLE1BQU0sQ0FBQyxDQUFBO1lBQ3ZDLE9BQU8sQ0FBQyxHQUFHLENBQUMsVUFBVSxJQUFJLENBQUMsS0FBSyxjQUFjLElBQUksQ0FBQyxTQUFTLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxhQUFhLElBQUksQ0FBQyxPQUFPLEVBQUUsQ0FBQyxDQUFBO1lBRW5HLE1BQU0sU0FBUyxHQUFjLElBQUksQ0FBQyxLQUFLLEtBQUssS0FBSyxDQUFDLENBQUMsQ0FBQyxFQUFFLEdBQUcsRUFBRSxJQUFJLENBQUMsU0FBUyxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsR0FBRyxFQUFFLElBQUksQ0FBQyxTQUFTLEVBQUUsQ0FBQTtZQUNyRyxJQUFJLElBQUksQ0FBQyxnQkFBZ0IsQ0FBQyxNQUFNO2dCQUFFLFNBQVMsQ0FBQyxJQUFJLEdBQUcsSUFBSSxDQUFDLGdCQUFnQixDQUFBO1lBRXhFLE1BQU0sTUFBTSxHQUFHLE1BQU0sSUFBSSxDQUFDLFNBQVMsQ0FBQyxFQUFFLFNBQVMsRUFBRSxRQUFRLEVBQUUsRUFBRSxJQUFJLEVBQUUsQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLEVBQUUsRUFBRSxFQUFFLElBQUksQ0FBQyxhQUFhLENBQUMsQ0FBQTtZQUMxRyxNQUFNLEdBQUcsR0FBRyxJQUFJLENBQUMsa0JBQWtCLENBQUMsSUFBSSxFQUFFLE1BQU0sQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQTtZQUVoRSxLQUFLLElBQUksQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLEdBQUcsR0FBRyxDQUFDLE1BQU0sRUFBRSxDQUFDLElBQUksU0FBUyxFQUFFLENBQUM7Z0JBQy9DLE1BQU0sSUFBQSxzQkFBZ0IsRUFBQztvQkFDckIsRUFBRSxFQUFFLElBQUksQ0FBQyxPQUFPO29CQUNoQixVQUFVLEVBQUUsRUFBRSxHQUFHLEVBQUUsR0FBRyxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsQ0FBQyxHQUFHLFNBQVMsQ0FBQyxFQUFFO2lCQUNqRCxDQUFDLENBQUE7WUFDSixDQUFDO1lBQ0QsT0FBTyxDQUFDLEdBQUcsQ0FBQyxZQUFZLEdBQUcsQ0FBQyxNQUFNLFNBQVMsQ0FBQyxDQUFBO1lBQzVDLE9BQU8sQ0FBQyxHQUFHLEVBQUUsQ0FBQTtRQUNmLENBQUM7S0FBQTtJQUVEOzs7OztPQUtHO0lBQ0csU0FBUztxRUFBRSxNQUFvQixFQUFFLFVBQVUsR0FBRyxLQUFLOztZQUN2RCxNQUFNLE1BQU0sR0FBdUIsRUFBRSxDQUFBO1lBQ3JDLElBQUksTUFBMEIsQ0FBQTtZQUM5QixHQUFHLENBQUM7Z0JBQ0YsTUFBTSxHQUFHLEdBQUcsTUFBTSxJQUFBLGtCQUFZLEVBQUM7b0JBQzdCLGlCQUFpQixFQUFFLEVBQUUsTUFBTSxFQUFFLFVBQVUsRUFBRSxVQUFVLElBQUksU0FBUyxFQUFFLElBQUksRUFBRSxTQUFTLEVBQUUsTUFBTSxFQUFFO2lCQUM1RixDQUFDLENBQUE7Z0JBQ0YsTUFBTSxDQUFDLElBQUksQ0FBQyxHQUFHLEdBQUcsQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUE7Z0JBQ2hDLE1BQU0sR0FBRyxNQUFBLEdBQUcsQ0FBQyxNQUFNLENBQUMsVUFBVSxtQ0FBSSxTQUFTLENBQUE7WUFDN0MsQ0FBQyxRQUFRLE1BQU0sRUFBQztZQUNoQixPQUFPLE1BQU0sQ0FBQTtRQUNmLENBQUM7S0FBQTtJQUVEOzs7OztPQUtHO0lBQ0csZUFBZSxDQUFFLE9BQXFCOztZQUMxQyxNQUFNLFFBQVEsR0FBRyxJQUFJLEdBQUcsQ0FBQyxPQUFPLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLGVBQWUsS0FBSyxJQUFJLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQTtZQUM3RixJQUFJLENBQUMsUUFBUSxDQUFDLElBQUk7Z0JBQUUsT0FBTTtZQUMxQixnRkFBZ0Y7WUFDaEYsTUFBTSxNQUFNLEdBQUcsQ0FBQyxNQUFNLElBQUEsZUFBUyxHQUFFLENBQUMsQ0FBQyxFQUFFLENBQUE7WUFFckMsS0FBSyxNQUFNLE9BQU8sSUFBSSxRQUFRLEVBQUUsQ0FBQztnQkFDL0IsT0FBTyxDQUFDLEdBQUcsQ0FBQyx3Q0FBd0MsT0FBTyxFQUFFLENBQUMsQ0FBQTtnQkFDOUQsSUFBSSxDQUFDO29CQUNILG1FQUFtRTtvQkFDbkUsTUFBTSxLQUFLLEdBQUcsT0FBTyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxPQUFPLEtBQUssT0FBTyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsSUFBSSxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFBO29CQUV4Rjs7O3NCQUdFO29CQUNGLE1BQU0sT0FBTyxHQUFHLE1BQU0sSUFBSSxDQUFDLHNCQUFzQixDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQTtvQkFDbEYsSUFBSSxPQUFPLENBQUMsTUFBTSxFQUFFLENBQUM7d0JBQ25CLE9BQU8sQ0FBQyxHQUFHLENBQUMsMENBQTBDLE9BQU8sQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLHlCQUF5QixDQUFDLENBQUE7d0JBQ2xHLFNBQVE7b0JBQ1YsQ0FBQztvQkFFRCxtRUFBbUU7b0JBQ25FLElBQUksR0FBeUIsQ0FBQTtvQkFDN0IsS0FBSyxNQUFNLElBQUksSUFBSSxLQUFLLEVBQUUsQ0FBQzt3QkFDekIsTUFBTSxNQUFNLEdBQUcsTUFBTSxJQUFJLENBQUMsU0FBUyxDQUFDLEVBQUUsUUFBUSxFQUFFLEVBQUUsR0FBRyxFQUFFLENBQUMsT0FBTyxDQUFDLEVBQUUsRUFBRSxFQUFFLEVBQUUsSUFBSSxDQUFDLGlCQUFpQixDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsQ0FBQTt3QkFDdkcsTUFBTSxTQUFTLEdBQUcsSUFBSSxHQUFHLENBQUMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxPQUFPLEtBQUssTUFBTSxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUE7d0JBQ2xGLEdBQUcsR0FBRyxHQUFHLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxNQUFNLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxTQUFTLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxTQUFTLENBQUMsQ0FBQTt3QkFDaEUsSUFBSSxDQUFDLEdBQUcsQ0FBQyxNQUFNOzRCQUFFLE1BQUs7b0JBQ3hCLENBQUM7b0JBQ0QsR0FBRyxHQUFHLEdBQUcsYUFBSCxHQUFHLGNBQUgsR0FBRyxHQUFJLEVBQUUsQ0FBQTtvQkFFZixLQUFLLElBQUksQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLEdBQUcsR0FBRyxDQUFDLE1BQU0sRUFBRSxDQUFDLElBQUksU0FBUyxFQUFFLENBQUM7d0JBQy9DLE1BQU0sSUFBQSwwQkFBb0IsRUFBQzs0QkFDekIsRUFBRSxFQUFFLE9BQU87NEJBQ1gsVUFBVSxFQUFFLEVBQUUsR0FBRyxFQUFFLEdBQUcsQ0FBQyxLQUFLLENBQUMsQ0FBQyxFQUFFLENBQUMsR0FBRyxTQUFTLENBQUMsRUFBRTt5QkFDakQsQ0FBQyxDQUFBO29CQUNKLENBQUM7b0JBQ0QsT0FBTyxDQUFDLEdBQUcsQ0FBQyxjQUFjLEdBQUcsQ0FBQyxNQUFNLFNBQVMsQ0FBQyxDQUFBO2dCQUNoRCxDQUFDO2dCQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUM7b0JBQ1gsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQTtnQkFDaEIsQ0FBQztZQUNILENBQUM7WUFDRCxPQUFPLENBQUMsR0FBRyxFQUFFLENBQUE7UUFDZixDQUFDO0tBQUE7SUFFRDs7OztPQUlHO0lBQ0gsaUJBQWlCLENBQUUsSUFBVTtRQUMzQixNQUFNLFFBQVEsR0FBeUIsSUFBSSxDQUFDLEtBQUssS0FBSyxLQUFLO1lBQ3pELENBQUMsQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLENBQUMsRUFBRSxTQUFTLEVBQUUsRUFBRSxJQUFJLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQztZQUMzRCxDQUFDLENBQUMsQ0FBQyxFQUFFLFNBQVMsRUFBRSxFQUFFLElBQUksRUFBRSxJQUFJLENBQUMsU0FBUyxFQUFFLEVBQUUsQ0FBQyxDQUFBO1FBQzdDLElBQUksSUFBSSxDQUFDLGdCQUFnQixDQUFDLE1BQU07WUFBRSxRQUFRLENBQUMsSUFBSSxDQUFDLEVBQUUsU0FBUyxFQUFFLEVBQUUsR0FBRyxFQUFFLElBQUksQ0FBQyxnQkFBZ0IsRUFBRSxFQUFFLENBQUMsQ0FBQTtRQUM5RixPQUFPLFFBQVEsQ0FBQTtJQUNqQixDQUFDO0lBRUQ7O09BRUc7SUFDRyxzQkFBc0IsQ0FBRSxTQUFtQjs7WUFDL0MsTUFBTSxPQUFPLEdBQWEsRUFBRSxDQUFBO1lBQzVCLEtBQUssTUFBTSxFQUFFLElBQUksSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLEVBQUUsQ0FBQztnQkFDcEMsTUFBTSxHQUFHLEdBQUcsTUFBTSxJQUFBLGtCQUFZLEVBQUM7b0JBQzdCLGlCQUFpQixFQUFFLEVBQUUsTUFBTSxFQUFFLEVBQUUsU0FBUyxFQUFFLEVBQUUsR0FBRyxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUUsRUFBRSxFQUFFLElBQUksRUFBRSxDQUFDLEVBQUU7aUJBQ3JFLENBQUMsQ0FBQTtnQkFDRixJQUFJLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsTUFBTTtvQkFBRSxPQUFPLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxDQUFBO1lBQ2hELENBQUM7WUFDRCxPQUFPLE9BQU8sQ0FBQTtRQUNoQixDQUFDO0tBQUE7SUFFRDs7T0FFRztJQUNILGtCQUFrQixDQUFFLElBQVUsRUFBRSxNQUEwQjtRQUN4RCxJQUFJLENBQUMsSUFBSSxDQUFDLGFBQWE7WUFBRSxPQUFPLE1BQU0sQ0FBQTtRQUN0QyxPQUFPLE1BQU0sQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLEVBQUU7O1lBQzNCLDRHQUE0RztZQUM1RyxJQUFJLENBQUMsQ0FBQSxNQUFBLEtBQUssQ0FBQyxNQUFNLDBDQUFFLE1BQU0sQ0FBQTtnQkFBRSxNQUFNLElBQUksS0FBSyxDQUFDLHVDQUF1QyxLQUFLLENBQUMsRUFBRSxrQ0FBa0MsQ0FBQyxDQUFBO1lBQzdILE9BQU8sS0FBSyxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQTtRQUN6RSxDQUFDLENBQUMsQ0FBQTtJQUNKLENBQUM7Q0FDRjtBQXJMRCxzQ0FxTEMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBMaW5rLCBMaW5rQ29uZmlnLCBDb25maWcgfSBmcm9tICcuL3R5cGVzJ1xuaW1wb3J0IHtcbiAgYWRkQXNzZXRzVG9BbGJ1bSxcbiAgQXNzZXRSZXNwb25zZUR0byxcbiAgZ2V0TXlVc2VyLFxuICBJZHNGaWx0ZXIsXG4gIHJlbW92ZUFzc2V0RnJvbUFsYnVtLFxuICBTZWFyY2hGaWx0ZXIsXG4gIFNlYXJjaEZpbHRlckJyYW5jaCxcbiAgc2VhcmNoQXNzZXRzXG59IGZyb20gJ0BpbW1pY2gvc2RrJ1xuaW1wb3J0IHBhdGggZnJvbSAncGF0aCdcblxuLyoqIE1heGltdW0gbnVtYmVyIG9mIGFzc2V0cyBpbiBvbmUgc2VhcmNoIHBhZ2UsIGFuZCBpbiBvbmUgYWRkLXRvLWFsYnVtIHJlcXVlc3QgKi9cbmNvbnN0IFBBR0VfU0laRSA9IDEwMDBcblxuZXhwb3J0IGNsYXNzIFBlcnNvblRvQWxidW0ge1xuICBjb25maWc6IENvbmZpZ1xuXG4gIGNvbnN0cnVjdG9yICgpIHtcbiAgICB0aGlzLmluaXRDb25maWcoKVxuICB9XG5cbiAgLyoqXG4gICAqIFJlYWQgdGhlIGNvbmZpZy5qc29uIGZpbGUgb3IgcGFyc2UgdGhlIENPTkZJRyBlbnYgdmFsdWUgdG8gZ2V0IHRoZSBjb25maWd1cmF0aW9uXG4gICAqL1xuICBpbml0Q29uZmlnICgpIHtcbiAgICB0cnkge1xuICAgICAgaWYgKHByb2Nlc3MuZW52LkNPTkZJRykge1xuICAgICAgICAvLyBBdHRlbXB0IHRvIHBhcnNlIGRvY2tlci1jb21wb3NlIGNvbmZpZyBzdHJpbmcgaW50byBKU09OIChpZiBzcGVjaWZpZWQpXG4gICAgICAgIHRoaXMuY29uZmlnID0gSlNPTi5wYXJzZShwcm9jZXNzLmVudi5DT05GSUcpXG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjb25zdCBjb25maWdKc29uID0gcmVxdWlyZShwYXRoLnJlc29sdmUoJy4uL2RhdGEvY29uZmlnLmpzb24nKSlcbiAgICAgICAgaWYgKHR5cGVvZiBjb25maWdKc29uID09PSAnb2JqZWN0JykgdGhpcy5jb25maWcgPSBjb25maWdKc29uXG4gICAgICB9XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgY29uc29sZS5sb2coZSlcbiAgICAgIGNvbnNvbGUubG9nKCdVbmFibGUgdG8gcGFyc2UgY29uZmlnIGZpbGUuJylcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogQXBwbHkgdGhlIGRlZmF1bHRzIHRvIGEgY29uZmlnIGxpbmsgYW5kIGNoZWNrIGl0cyBmaWVsZHMuIFRocm93cyBpZiB0aGUgbGluayBpcyBpbnZhbGlkLlxuICAgKi9cbiAgbm9ybWFsaXNlTGluayAoY29uZmlnOiBMaW5rQ29uZmlnKTogTGluayB7XG4gICAgY29uc3QgcGVyc29uSWRzID0gY29uZmlnLnBlcnNvbklkcyA/PyAoY29uZmlnLnBlcnNvbklkID8gW2NvbmZpZy5wZXJzb25JZF0gOiBbXSlcbiAgICAvLyBUaGUgbG9naWMgbWFrZXMgbm8gZGlmZmVyZW5jZSBmb3Igb25lIHBlcnNvbiwgc28gaXQgaXMgb25seSBuZWNlc3NhcnkgZm9yIHR3byBvciBtb3JlXG4gICAgY29uc3QgbG9naWMgPSBjb25maWcubG9naWMgPz8gKHBlcnNvbklkcy5sZW5ndGggPT09IDEgPyAnT1InIDogdW5kZWZpbmVkKVxuICAgIGNvbnN0IGV4Y2x1ZGVQZXJzb25JZHMgPSBjb25maWcuZXhjbHVkZVBlcnNvbklkcyA/PyBbXVxuXG4gICAgaWYgKCFjb25maWcuYWxidW1JZCkgdGhyb3cgbmV3IEVycm9yKCdJbnZhbGlkIGxpbms6IGFsYnVtSWQgaXMgbWlzc2luZycpXG4gICAgaWYgKCFwZXJzb25JZHMubGVuZ3RoKSB0aHJvdyBuZXcgRXJyb3IoJ0ludmFsaWQgbGluazogcGVyc29uSWRzIGlzIGVtcHR5JylcbiAgICBpZiAobG9naWMgIT09ICdBTkQnICYmIGxvZ2ljICE9PSAnT1InKSB0aHJvdyBuZXcgRXJyb3IoYEludmFsaWQgbGluazogc2V0IGxvZ2ljIHRvIEFORCBvciBPUiwgbm90ICR7bG9naWN9YClcbiAgICBjb25zdCBvdmVybGFwID0gcGVyc29uSWRzLmZpbHRlcihpZCA9PiBleGNsdWRlUGVyc29uSWRzLmluY2x1ZGVzKGlkKSlcbiAgICBpZiAob3ZlcmxhcC5sZW5ndGgpIHRocm93IG5ldyBFcnJvcihgSW52YWxpZCBsaW5rOiAke292ZXJsYXAuam9pbignLCAnKX0gaXMgaW4gcGVyc29uSWRzIGFuZCBleGNsdWRlUGVyc29uSWRzYClcblxuICAgIHJldHVybiB7XG4gICAgICBkZXNjcmlwdGlvbjogY29uZmlnLmRlc2NyaXB0aW9uLFxuICAgICAgYWxidW1JZDogY29uZmlnLmFsYnVtSWQsXG4gICAgICBwZXJzb25JZHMsXG4gICAgICBsb2dpYyxcbiAgICAgIGV4Y2x1ZGVQZXJzb25JZHMsXG4gICAgICBub090aGVyUGVvcGxlOiBjb25maWcubm9PdGhlclBlb3BsZSA9PT0gdHJ1ZSxcbiAgICAgIHJlbW92ZVVubWF0Y2hlZDogY29uZmlnLnJlbW92ZVVubWF0Y2hlZCA9PT0gdHJ1ZVxuICAgIH1cbiAgfVxuXG4gIGFzeW5jIHByb2Nlc3NMaW5rIChjb25maWc6IExpbmtDb25maWcpIHtcbiAgICBpZiAoY29uZmlnLmRlc2NyaXB0aW9uKSBjb25zb2xlLmxvZyhgPT09ICR7Y29uZmlnLmRlc2NyaXB0aW9ufSA9PT1gKVxuICAgIGNvbnN0IGxpbmsgPSB0aGlzLm5vcm1hbGlzZUxpbmsoY29uZmlnKVxuICAgIGNvbnNvbGUubG9nKGBBZGRpbmcgJHtsaW5rLmxvZ2ljfSBvZiBwZW9wbGUgJHtsaW5rLnBlcnNvbklkcy5qb2luKCcsICcpfSB0byBhbGJ1bSAke2xpbmsuYWxidW1JZH1gKVxuXG4gICAgY29uc3QgcGVyc29uSWRzOiBJZHNGaWx0ZXIgPSBsaW5rLmxvZ2ljID09PSAnQU5EJyA/IHsgYWxsOiBsaW5rLnBlcnNvbklkcyB9IDogeyBhbnk6IGxpbmsucGVyc29uSWRzIH1cbiAgICBpZiAobGluay5leGNsdWRlUGVyc29uSWRzLmxlbmd0aCkgcGVyc29uSWRzLm5vbmUgPSBsaW5rLmV4Y2x1ZGVQZXJzb25JZHNcblxuICAgIGNvbnN0IGFzc2V0cyA9IGF3YWl0IHRoaXMuc2VhcmNoQWxsKHsgcGVyc29uSWRzLCBhbGJ1bUlkczogeyBub25lOiBbbGluay5hbGJ1bUlkXSB9IH0sIGxpbmsubm9PdGhlclBlb3BsZSlcbiAgICBjb25zdCBpZHMgPSB0aGlzLmFwcGx5Tm9PdGhlclBlb3BsZShsaW5rLCBhc3NldHMpLm1hcCh4ID0+IHguaWQpXG5cbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGlkcy5sZW5ndGg7IGkgKz0gUEFHRV9TSVpFKSB7XG4gICAgICBhd2FpdCBhZGRBc3NldHNUb0FsYnVtKHtcbiAgICAgICAgaWQ6IGxpbmsuYWxidW1JZCxcbiAgICAgICAgYnVsa0lkc0R0bzogeyBpZHM6IGlkcy5zbGljZShpLCBpICsgUEFHRV9TSVpFKSB9XG4gICAgICB9KVxuICAgIH1cbiAgICBjb25zb2xlLmxvZyhgIC0gQWRkZWQgJHtpZHMubGVuZ3RofSBhc3NldHNgKVxuICAgIGNvbnNvbGUubG9nKClcbiAgfVxuXG4gIC8qKlxuICAgKiBHZXQgZXZlcnkgYXNzZXQgdGhhdCBtYXRjaGVzIGEgc2VhcmNoIGZpbHRlci5cbiAgICpcbiAgICogVGhlIHNlYXJjaCBjdXJzb3IgaXMgYW4gb2Zmc2V0LiBBIGNoYW5nZSB0byBhbiBhbGJ1bSBjaGFuZ2VzIHRoZSByZXN1bHRzIG9mIGEgc2VhcmNoIHRoYXRcbiAgICogZmlsdGVycyBvbiB0aGF0IGFsYnVtLCBzbyB0aGlzIGNvbGxlY3RzIGV2ZXJ5IHBhZ2UgYmVmb3JlIHRoZSBjYWxsZXIgYWRkcyBvciByZW1vdmVzIGFzc2V0cy5cbiAgICovXG4gIGFzeW5jIHNlYXJjaEFsbCAoZmlsdGVyOiBTZWFyY2hGaWx0ZXIsIHdpdGhQZW9wbGUgPSBmYWxzZSkge1xuICAgIGNvbnN0IGFzc2V0czogQXNzZXRSZXNwb25zZUR0b1tdID0gW11cbiAgICBsZXQgY3Vyc29yOiBzdHJpbmcgfCB1bmRlZmluZWRcbiAgICBkbyB7XG4gICAgICBjb25zdCByZXMgPSBhd2FpdCBzZWFyY2hBc3NldHMoe1xuICAgICAgICBtZXRhZGF0YVNlYXJjaER0bzogeyBmaWx0ZXIsIHdpdGhQZW9wbGU6IHdpdGhQZW9wbGUgfHwgdW5kZWZpbmVkLCBzaXplOiBQQUdFX1NJWkUsIGN1cnNvciB9XG4gICAgICB9KVxuICAgICAgYXNzZXRzLnB1c2goLi4ucmVzLmFzc2V0cy5pdGVtcylcbiAgICAgIGN1cnNvciA9IHJlcy5hc3NldHMubmV4dEN1cnNvciA/PyB1bmRlZmluZWRcbiAgICB9IHdoaWxlIChjdXJzb3IpXG4gICAgcmV0dXJuIGFzc2V0c1xuICB9XG5cbiAgLyoqXG4gICAqIFJlbW92ZSB0aGUgYXNzZXRzIHRoYXQgbWF0Y2ggbm9uZSBvZiB0aGUgbGlua3Mgb2YgYW4gYWxidW0uIE9ubHkgdGhlIGFsYnVtcyB0aGF0IGhhdmVcbiAgICogYSBsaW5rIHdpdGggYHJlbW92ZVVubWF0Y2hlZGAgYXJlIHByb2Nlc3NlZC5cbiAgICpcbiAgICogQHBhcmFtIGNvbmZpZ3MgLSBBbGwgdGhlIGxpbmtzIG9mIG9uZSB1c2VyXG4gICAqL1xuICBhc3luYyByZW1vdmVVbm1hdGNoZWQgKGNvbmZpZ3M6IExpbmtDb25maWdbXSkge1xuICAgIGNvbnN0IGFsYnVtSWRzID0gbmV3IFNldChjb25maWdzLmZpbHRlcih4ID0+IHgucmVtb3ZlVW5tYXRjaGVkID09PSB0cnVlKS5tYXAoeCA9PiB4LmFsYnVtSWQpKVxuICAgIGlmICghYWxidW1JZHMuc2l6ZSkgcmV0dXJuXG4gICAgLy8gT3RoZXIgdXNlcnMgY2FuIGFkZCBhc3NldHMgdG8gYSBzaGFyZWQgYWxidW0uIFRob3NlIGFzc2V0cyBhcmUgbmV2ZXIgcmVtb3ZlZC5cbiAgICBjb25zdCB1c2VySWQgPSAoYXdhaXQgZ2V0TXlVc2VyKCkpLmlkXG5cbiAgICBmb3IgKGNvbnN0IGFsYnVtSWQgb2YgYWxidW1JZHMpIHtcbiAgICAgIGNvbnNvbGUubG9nKGBSZW1vdmluZyB1bm1hdGNoZWQgYXNzZXRzIGZyb20gYWxidW0gJHthbGJ1bUlkfWApXG4gICAgICB0cnkge1xuICAgICAgICAvLyBBbiBpbnZhbGlkIGxpbmsgdGhyb3dzIGhlcmUsIGFuZCB0aGUgYWxidW0gaXMgdGhlbiBsZWZ0IGFzIGl0IGlzXG4gICAgICAgIGNvbnN0IGxpbmtzID0gY29uZmlncy5maWx0ZXIoeCA9PiB4LmFsYnVtSWQgPT09IGFsYnVtSWQpLm1hcCh4ID0+IHRoaXMubm9ybWFsaXNlTGluayh4KSlcblxuICAgICAgICAvKlxuICAgICAgICBBIHBlcnNvbiBJRCBzdG9wcyBtYXRjaGluZyB3aGVuIHRoZSBwZXJzb24gaXMgbWVyZ2VkIG9yIGZhY2UgcmVjb2duaXRpb24gaXMgcmVzZXQuXG4gICAgICAgIFRoZSBhbGJ1bSB3b3VsZCB0aGVuIGxvc2UgYWxsIHRoZSBwaG90b3Mgb2YgdGhhdCBwZXJzb24sIHNvIGRvIG5vdGhpbmcgaW5zdGVhZC5cbiAgICAgICAgKi9cbiAgICAgICAgY29uc3QgbWlzc2luZyA9IGF3YWl0IHRoaXMuZmluZFBlb3BsZVdpdGhOb0Fzc2V0cyhsaW5rcy5mbGF0TWFwKHggPT4geC5wZXJzb25JZHMpKVxuICAgICAgICBpZiAobWlzc2luZy5sZW5ndGgpIHtcbiAgICAgICAgICBjb25zb2xlLmxvZyhgIC0gU2tpcHBlZDogbm8gYXNzZXRzIGZvdW5kIGZvciBwZW9wbGUgJHttaXNzaW5nLmpvaW4oJywgJyl9LiBDaGVjayB0aGUgcGVyc29uIElEcy5gKVxuICAgICAgICAgIGNvbnRpbnVlXG4gICAgICAgIH1cblxuICAgICAgICAvLyBBbiBhc3NldCBpcyByZW1vdmVkIG9ubHkgd2hlbiBldmVyeSBsaW5rIG9mIHRoZSBhbGJ1bSByZWplY3RzIGl0XG4gICAgICAgIGxldCBpZHM6IHN0cmluZ1tdIHwgdW5kZWZpbmVkXG4gICAgICAgIGZvciAoY29uc3QgbGluayBvZiBsaW5rcykge1xuICAgICAgICAgIGNvbnN0IGFzc2V0cyA9IGF3YWl0IHRoaXMuc2VhcmNoQWxsKHsgYWxidW1JZHM6IHsgYW55OiBbYWxidW1JZF0gfSwgb3I6IHRoaXMudW5tYXRjaGVkQnJhbmNoZXMobGluaykgfSlcbiAgICAgICAgICBjb25zdCB1bm1hdGNoZWQgPSBuZXcgU2V0KGFzc2V0cy5maWx0ZXIoeCA9PiB4Lm93bmVySWQgPT09IHVzZXJJZCkubWFwKHggPT4geC5pZCkpXG4gICAgICAgICAgaWRzID0gaWRzID8gaWRzLmZpbHRlcihpZCA9PiB1bm1hdGNoZWQuaGFzKGlkKSkgOiBbLi4udW5tYXRjaGVkXVxuICAgICAgICAgIGlmICghaWRzLmxlbmd0aCkgYnJlYWtcbiAgICAgICAgfVxuICAgICAgICBpZHMgPSBpZHMgPz8gW11cblxuICAgICAgICBmb3IgKGxldCBpID0gMDsgaSA8IGlkcy5sZW5ndGg7IGkgKz0gUEFHRV9TSVpFKSB7XG4gICAgICAgICAgYXdhaXQgcmVtb3ZlQXNzZXRGcm9tQWxidW0oe1xuICAgICAgICAgICAgaWQ6IGFsYnVtSWQsXG4gICAgICAgICAgICBidWxrSWRzRHRvOiB7IGlkczogaWRzLnNsaWNlKGksIGkgKyBQQUdFX1NJWkUpIH1cbiAgICAgICAgICB9KVxuICAgICAgICB9XG4gICAgICAgIGNvbnNvbGUubG9nKGAgLSBSZW1vdmVkICR7aWRzLmxlbmd0aH0gYXNzZXRzYClcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgY29uc29sZS5sb2coZSlcbiAgICAgIH1cbiAgICB9XG4gICAgY29uc29sZS5sb2coKVxuICB9XG5cbiAgLyoqXG4gICAqIFRoZSBzZWFyY2ggYnJhbmNoZXMgdGhhdCBmaW5kIHRoZSBhc3NldHMgYSBsaW5rIHJlamVjdHMuIEFuIGFzc2V0IHRoYXQgbWF0Y2hlcyBvbmUgYnJhbmNoIGlzIHJlamVjdGVkLlxuICAgKlxuICAgKiBgbm9PdGhlclBlb3BsZWAgaGFzIG5vIHNlYXJjaCBmaWx0ZXIsIHNvIGFuIGFzc2V0IHRoYXQgaXQgcmVqZWN0cyBpcyBub3QgZm91bmQgaGVyZS5cbiAgICovXG4gIHVubWF0Y2hlZEJyYW5jaGVzIChsaW5rOiBMaW5rKTogU2VhcmNoRmlsdGVyQnJhbmNoW10ge1xuICAgIGNvbnN0IGJyYW5jaGVzOiBTZWFyY2hGaWx0ZXJCcmFuY2hbXSA9IGxpbmsubG9naWMgPT09ICdBTkQnXG4gICAgICA/IGxpbmsucGVyc29uSWRzLm1hcChpZCA9PiAoeyBwZXJzb25JZHM6IHsgbm9uZTogW2lkXSB9IH0pKVxuICAgICAgOiBbeyBwZXJzb25JZHM6IHsgbm9uZTogbGluay5wZXJzb25JZHMgfSB9XVxuICAgIGlmIChsaW5rLmV4Y2x1ZGVQZXJzb25JZHMubGVuZ3RoKSBicmFuY2hlcy5wdXNoKHsgcGVyc29uSWRzOiB7IGFueTogbGluay5leGNsdWRlUGVyc29uSWRzIH0gfSlcbiAgICByZXR1cm4gYnJhbmNoZXNcbiAgfVxuXG4gIC8qKlxuICAgKiBHZXQgdGhlIHBlcnNvbiBJRHMgZnJvbSBhIGxpc3QgdGhhdCBoYXZlIG5vIGFzc2V0cyBpbiBJbW1pY2hcbiAgICovXG4gIGFzeW5jIGZpbmRQZW9wbGVXaXRoTm9Bc3NldHMgKHBlcnNvbklkczogc3RyaW5nW10pIHtcbiAgICBjb25zdCBtaXNzaW5nOiBzdHJpbmdbXSA9IFtdXG4gICAgZm9yIChjb25zdCBpZCBvZiBuZXcgU2V0KHBlcnNvbklkcykpIHtcbiAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IHNlYXJjaEFzc2V0cyh7XG4gICAgICAgIG1ldGFkYXRhU2VhcmNoRHRvOiB7IGZpbHRlcjogeyBwZXJzb25JZHM6IHsgYW55OiBbaWRdIH0gfSwgc2l6ZTogMSB9XG4gICAgICB9KVxuICAgICAgaWYgKCFyZXMuYXNzZXRzLml0ZW1zLmxlbmd0aCkgbWlzc2luZy5wdXNoKGlkKVxuICAgIH1cbiAgICByZXR1cm4gbWlzc2luZ1xuICB9XG5cbiAgLyoqXG4gICAqIFdoZW4gYG5vT3RoZXJQZW9wbGVgIGlzIHNldCwgcmVtb3ZlIHRoZSBhc3NldHMgdGhhdCBjb250YWluIGEgcGVyc29uIHdobyBpcyBub3QgaW4gYHBlcnNvbklkc2BcbiAgICovXG4gIGFwcGx5Tm9PdGhlclBlb3BsZSAobGluazogTGluaywgYXNzZXRzOiBBc3NldFJlc3BvbnNlRHRvW10pIHtcbiAgICBpZiAoIWxpbmsubm9PdGhlclBlb3BsZSkgcmV0dXJuIGFzc2V0c1xuICAgIHJldHVybiBhc3NldHMuZmlsdGVyKGFzc2V0ID0+IHtcbiAgICAgIC8vIEVhY2ggc2VhcmNoIHJlc3VsdCBjb250YWlucyBhIHBlcnNvbiBmcm9tIHRoZSBsaW5rLCBzbyBhbiBlbXB0eSBsaXN0IG1lYW5zIEltbWljaCBkaWQgbm90IHNlbmQgdGhlIHBlb3BsZVxuICAgICAgaWYgKCFhc3NldC5wZW9wbGU/Lmxlbmd0aCkgdGhyb3cgbmV3IEVycm9yKGBJbW1pY2ggcmV0dXJuZWQgbm8gcGVvcGxlIGZvciBhc3NldCAke2Fzc2V0LmlkfS4gQ2hlY2sgdGhlIEFQSSBrZXkgcGVybWlzc2lvbnMuYClcbiAgICAgIHJldHVybiBhc3NldC5wZW9wbGUuZXZlcnkocGVyc29uID0+IGxpbmsucGVyc29uSWRzLmluY2x1ZGVzKHBlcnNvbi5pZCkpXG4gICAgfSlcbiAgfVxufVxuIl19